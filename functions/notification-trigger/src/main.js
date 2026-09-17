
import {
  Client,
  TablesDB,
  Messaging,
  MessagePriority,
  Query,
  Users,
  Role,
  Permission,
  Teams
} from "node-appwrite";

import fetch from "node-fetch";

import admin from "firebase-admin";

async function sendFCMNotify(token, title, body, admin) {
  try {
    const message = {
      token,
      notification: {
        title: title,
        body: body,
      },
      android: {
        ttl: 60 * 1000, // 1 minute
        priority: "high",
        notification: {
          sound: "notification",
          channelId: "priority_high_v1",
          priority: "max",
          defaultSound: false,
        },
      },
    };

    const response = await admin.messaging().send(message);

    console.log("Successfully sent:", response);

    return {
      success: true,
      messageId: response,
    };
  } catch (error) {
    console.error("Error sending notification:", error);

    return {
      success: false,
      error: error.message,
    };
  }
}

export default async ({ req, res, log, error }) => {
  try {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_SERVER_API_KEY);

    const messaging = new Messaging(client);
    const tablesDB = new TablesDB(client);
    const users = new Users(client);
    const teams = new Teams(client);

    const data = req.bodyJson;

    const ip = data?.ip;
    const errorFlags = data?.errorFlags;
    const shopID = data?.shopID;
    const isError = data?.isError;
    const pageCount = data?.pageCount ?? 0;
    const displayText = data?.displayText ?? "In next update";

    // ✅ Validate input
    if (!ip || !shopID) {
      return res.json({
        success: false,
        message: "Missing required fields (ip, shopID)"
      });
    }

    log(`Printer IP: ${ip}`);
    log(`Errors: ${JSON.stringify(errorFlags)}`);
    log(`Shop ID: ${shopID}`);

    // ✅ Get shop
    const shopData = await tablesDB.getRow(
      "printa4",
      "shops",
      shopID
    );

    // ✅ Get printer
    const printers = await tablesDB.listRows(
      "printa4",
      "printers",
      [
        Query.equal("printerIP", ip),
        Query.equal("shopId", shopID)
      ]
    );

    if (printers.total === 0) {
      log(`Printer ${ip} not found for shop ${shopID}`);

      return res.json({
        success: true,
        message: "Printer not registered for this shop"
      });
    }

    const printer = printers.rows[0];

    if (!errorFlags) {
      const documents = await tablesDB.listRows(
        "printa4",
        "maintenance",
        [
          Query.equal("printer_id", printer.$id),
          Query.orderDesc("$createdAt"),
          Query.limit(100)
        ]
      );

      for (const doc of documents.rows) {
        await tablesDB.updateRow(
          "printa4",
          "maintenance",
          doc.$id,
          {
            printerFixed: true
          }
        );
      }
    }

    if (errorFlags[0] === "lowPaper") {
      const check_resp = await tablesDB.listRows(
        "printa4",
        "maintenance",
        [
          Query.equal("printer_id", printer.$id),
          Query.orderDesc("$createdAt"),
          Query.limit(1)
        ]
      );

      const checkdoc = check_resp.rows[0];

      if (checkdoc.error_type === "lowPaper") {
        return res.json({
          success: false,
          message: "ok"
        });
      }
    }

    // ✅ Parse notify users safely
    const targetIds = [];
    const userIds = [];
    const userPhones = [];

    const PROVIDER_ID = "maintenanceapp";
    const PROVIDER_ID_2 = "maintainanceapp";

    // Get all memberships from the team
    const memberships = await teams.listMemberships(shopID);

    // Extract user IDs
    const memberUserIds = memberships.memberships
      .map(m => m.userId)
      .filter(Boolean);

    for (const userId of memberUserIds) {
      try {
        // Get user details
        const user = await users.get(userId);

        userIds.push(user.$id);

        if (user.phone) {
          userPhones.push(user.phone);
        }

        // Get push targets
        const targetsResult = await users.listTargets(user.$id);

        const ids = targetsResult.targets
          .filter(target =>
            target.providerType === "push" &&
            (
              target.providerId === PROVIDER_ID ||
              target.providerId === PROVIDER_ID_2
            )
          )
          .map(target => target.identifier);

        targetIds.push(...ids);

      } catch (err) {
        console.error(
          `Failed processing user ${userId}:`,
          err
        );
      }
    }

    // ✅ Safe error text
    const errorText = Array.isArray(errorFlags)
      ? errorFlags.join(", ")
      : "Unknown error";

    // ✅ Common message setup
    const title = isError
      ? `Printer Error - ${shopData.name}`
      : `Printer Status - ${shopData.name}`;

    const body = isError
      ? `Printer ${printer.name} (${ip}) at ${shopData.name} has errors: ${errorText} || ${displayText}`
      : `Printer ${printer.name} (${ip}) at ${shopData.name} is Fixed. No errors detected.`;

    const type = isError
      ? "printer_error"
      : "printer_status";

    const priority = isError
      ? MessagePriority.High
      : MessagePriority.Normal;

    if (isError) {
      await tablesDB.createRow(
        "printa4",
        "maintenance",
        "unique()",
        {
          printer_id: printer.$id,
          startTime: new Date().toISOString(),
          error_type: errorFlags[0] || "unknown",
          printerFixed: false,
          pageCount: pageCount
        },
        [
          Permission.read(Role.team(shopID)),
          Permission.update(Role.team(shopID)),
        ]
      );

    } else {
      const response = await tablesDB.listRows(
        "printa4",
        "maintenance",
        [
          Query.equal("printer_id", printer.$id),
          Query.orderDesc("$createdAt"),
          Query.limit(100)
        ]
      );

      console.log(
        `Found ${response.rows.length} documents`
      );

      for (const doc of response.rows) {
        await tablesDB.updateRow(
          "printa4",
          "maintenance",
          doc.$id,
          {
            printerFixed: true,
          }
        );

        console.log(
          `Updated permissions for ${doc.$id}`
        );
      }

      console.log("Done");
    }

    // ✅ Send Push Notification
    if (targetIds.length > 0 && isError) {
      const results = await Promise.allSettled(
        targetIds.map(targetId =>
          sendFCMNotify(
            targetId,
            title,
            body,
            admin
          )
        )
      );

      console.log(results);
    }

    // ✅ Send WhatsApp messages in parallel
    await Promise.all(
      userPhones.map(async (phone) => {
        try {
          const userDoc = await tablesDB.getRow(
            "printa4",
            "whatsapp",
            phone.replace("+", "")
          );

          const inbox_id = userDoc.inbox_id;

          await fetch(
            `https://chat.ridemap365.in/api/v1/accounts/1/conversations/${inbox_id}/messages`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "api_access_token": "9Mpxzz2iajqbptDoS51Kiz9j"
              },
              body: JSON.stringify({
                content: body,
                message_type: "outgoing"
              })
            }
          );

        } catch (err) {
          error(
            `WhatsApp send failed for ${phone}: ${err.message}`
          );
        }
      })
    );

    return res.json({
      success: true,
      printer: printer.name,
      notifiedUsers: targetIds.length
    });

  } catch (err) {
    error("Function failed: " + err.message);

    return res.json({
      success: false,
      message: err.message
    });
  }
};
