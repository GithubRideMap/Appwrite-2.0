import crypto from "crypto";
import {
  Client,
  TablesDB,
  Query,
  Messaging,
  MessagePriority,
  Permission,
  Role,
  Storage
} from "node-appwrite";

async function findCapablePrinters(shopId, color, sides, tablesDB) {
  try {
    const jobNeedsColor = color === "color";
    const jobNeedsDuplex = sides === "Two-Sided";

    const queries = [
      Query.equal("shopId", shopId),
    ];

    // Only filter when the job REQUIRES the feature
    // Color printer can print B/W also
    // Duplex printer can print single-side also

    if (jobNeedsColor) {
      queries.push(Query.equal("is_color", true));
    }

    if (jobNeedsDuplex) {
      queries.push(Query.equal("is_duplex", true));
    }

    const response = await tablesDB.listRows(
      "printa4",
      "printers",
      queries
    );

    if (!response.rows.length) {
      throw new Error("No capable printers found");
    }

    // Return ALL capable printers
    const printers = response.rows.map((doc) => doc.name);

    return printers;
  } catch (err) {
    return [];
  }
}

/**
 * Appwrite Function – Razorpay Webhook Handler
 * Handles:
 *  - payment.captured
 *  - payment.failed
 */
export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_PROJECT_ID)
      .setKey(process.env.APPWRITE_SERVER_API_KEY);

    const tablesDB = new TablesDB(client);
    const messaging = new Messaging(client);
    const storage = new Storage(client);

    const payload = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    const event = payload.event;
    const payment = payload.payload?.payment?.entity;

    log(payment);

    const orderId = payment.order_id;

    const transactionResult = await tablesDB.listRows(
      "printa4",
      "transactions",
      [Query.equal("order_id", orderId)]
    );

    if (transactionResult.total === 0) {
      error(`No transaction found for order_id: ${orderId}`);
      return res.json({ success: false }, 404);
    }

    const transaction = transactionResult.rows[0];

    if (transaction.is_paid === true && event === "payment.captured") {
      log("Transaction already marked as paid.");
      return res.json({ success: true });
    }

    if (!payment) {
      error("Invalid webhook payload structure");
      return res.json({ success: false }, 400);
    }

    switch (event) {
      case "payment.captured":
        if (payment.notes && payment.notes.payment_type === "print") {
          const result = await tablesDB.listRows(
            "printa4",
            "jobs",
            [Query.equal("transaction_id", orderId)]
          );

          if (result.total === 0) {
            error(`No job found for transaction_id: ${orderId}`);
            return res.json({ success: false }, 404);
          }

          const job = result.rows[0];

          if (job.payment_status === true && event === "payment.captured") {
            log("Payment already marked as successful for this job.");
            return res.json({ success: true });
          }

          await storage.updateFile({
            bucketId: job.user_id,
            fileId: job.file_id,
            permissions: [
              Permission.read(Role.user(job.org_id)),
              Permission.read(Role.users()),
            ],
          });

          const jobId = job.$id;

          log(`Job ${transaction.$id} marked as paid.`);

          await tablesDB.updateRow(
            "printa4",
            "transactions",
            String(transaction.$id),
            {
              is_paid: true,
              amount: payment.amount / 100,
              pay_id: String(payment.id)
            }
          );

          let permissions;

          if (job.print_options.print_later) {
            permissions = [
              Permission.read(Role.user(job.user_id))
            ];
          } else {
            permissions = [
              Permission.read(Role.user(job.user_id)),
              Permission.update(Role.user(job.org_id)),
              Permission.read(Role.user(job.org_id)),
            ];
          }

          const org_data = await tablesDB.getRow(
            "printa4",
            "shops",
            job.org_id
          );

          await tablesDB.updateRow(
            "printa4",
            "jobs",
            jobId,
            {
              paid_at: new Date().toISOString(),
              payment_status: true,
              payment_message: "Payment successful via UPI",
              payment_failed: false,
              print_message: job.print_options.print_later
                ? "pending"
                : (org_data.isAutoPrint ? "queued" : "pending")
            },
            permissions
          );

          if (!job.print_options.print_later) {
            if (org_data.isAutoPrint) {
              const capabalePrinters = await findCapablePrinters(
                job.org_id,
                JSON.parse(job.print_options).color,
                JSON.parse(job.print_options).sides,
                tablesDB
              );

              await tablesDB.createRow(
                "printa4",
                "queue",
                jobId,
                {
                  printers: capabalePrinters
                },
                [
                  Permission.read(Role.user(job.org_id)),
                  Permission.delete(Role.user(job.org_id))
                ]
              );
            }
          }

          await messaging.createPush({
            messageId: "unique()",

            title: "Payment Successful 💳",
            body: `Your payment for the print job ${job.session_code} ₹${job.estimated_cost} has been received.`,

            users: [payment.notes.userId],

            data: {
              type: "debit",
              amount: String(job.estimated_cost),
              balance: String(job.estimated_cost),
              screen: "history"
            },

            tag: `payment_success_${jobId}_${Date.now()}`,
            priority: MessagePriority.High
          });
        }

        if (payment.notes && payment.notes.payment_type === "wallet") {
          const userId = payment.notes.userId || null;
          const amount = payment.amount || 0;

          if (userId) {
            const userWalletResult = await tablesDB.getRow(
              "printa4",
              "users",
              userId
            );

            const currentBalance = userWalletResult.wallet_balance || 0;

            const newBalance = currentBalance + amount / 100; // Assuming amount is in paise

            await tablesDB.updateRow(
              "printa4",
              "users",
              userId,
              {
                wallet_balance: newBalance
              }
            );

            await tablesDB.updateRow(
              "printa4",
              "transactions",
              String(transaction.$id),
              {
                is_paid: true,
                amount: payment.amount / 100,
                pay_id: String(payment.id)
              }
            );

            await messaging.createPush({
              messageId: "unique()",

              title: "Payment Successful 💳",
              body: `Your wallet has been topped up with ₹${amount / 100}. New balance: ₹${newBalance}.`,

              users: [userId],

              data: {
                type: "credit",
                amount: String(amount / 100),
                balance: String(newBalance),
                screen: "wallet"
              },

              tag: `wallet_topup_${userId}_${Date.now()}`,
              priority: MessagePriority.High
            });
          }
        }

        break;

      default:
        log(`⚠️ Unhandled Razorpay event: ${event}`);
    }

    return res.json({ success: true });

  } catch (err) {
    error("Webhook handler error: " + err.message);
    return res.json({ success: false }, 500);
  }
};