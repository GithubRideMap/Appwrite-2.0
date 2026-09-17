import { Client, TablesDB, Permission, Role, Storage, Messaging, MessagePriority, Query, Users, Functions } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { PDFDocument } from 'pdf-lib';
import { createPdf } from "./pdfgen.js";
import Razorpay from "razorpay";

// NEVER hardcode these in real code
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_live_9oZ9QrAVH39Gzf";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "lukVuKshCcBpYTeJzgBnOKF5";

async function getFilePages(userID, fileId, storage) {
  const fileBuffer = await storage.getFileDownload(userID, fileId);
  // 2. Load PDF and get page count
  const pdfDoc = await PDFDocument.load(fileBuffer);
  const pageCount = pdfDoc.getPageCount();
  return pageCount;
}

function generateSessionId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function isMoreThan10Minutes(paid_at) {
  const paidTime = new Date(paid_at).getTime();
  const now = Date.now();

  const diffInMs = now - paidTime;
  const diffInMinutes = diffInMs / (1000 * 60);

  return diffInMinutes > 300;
}

function countUniquePages(rangeStr) {
  if (!rangeStr || typeof rangeStr !== "string") return 0;

  const pages = new Set();

  rangeStr.split(",").forEach(part => {
    part = part.trim();

    if (part.includes("-")) {
      let [start, end] = part.split("-").map(Number);
      if (!isNaN(start) && !isNaN(end)) {
        if (start > end) [start, end] = [end, start]; // normalize
        for (let i = start; i <= end; i++) {
          pages.add(i);
        }
      }
    } else {
      const page = Number(part);
      if (!isNaN(page)) {
        pages.add(page);
      }
    }
  });

  return pages.size;
}

export async function authorizePayment(amount, phone, payment_type, userId) {
  const razorpayClient = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
  const amountInPaise = Math.round(parseFloat(amount) * 100);
  const currency = "INR";
  const order = await razorpayClient.orders.create({
    amount: amountInPaise,
    currency,
    payment_capture: 1,
    notes: {
      payment_type,
      userId,
    }
  });

  return {
    order_id: order.id,
    amount: amountInPaise,
    currency,
    key: RAZORPAY_KEY_ID,
    mobile: phone,
  };
}

function validatePrintOptions(data) {
  const requiredFields = [
    "copies",
    "orientation",
    "pages",
    "pages_per_sheet",
    "color",
    "sides",
    "media",
    "print_now",
    "mobile",
    "file_id",
    "print_later"
  ];

  const missing = requiredFields.filter(
    (key) => data[key] === undefined || data[key] === null
  );

  return {
    valid: missing.length === 0,
    missing
  };
}

function calculateEstimatedCost(print_options, org_price, total_pages) {
  const {
    copies = 1,
    color = "bw",
    sides = "One-Sided",
    pages_per_sheet = 1
  } = print_options;

  const pages = Number(total_pages);
  const copyCount = Number(copies);
  const pagesPerSheet = Number(pages_per_sheet);

  // ---------------------------------------------------------
  // Validation
  // ---------------------------------------------------------

  if (!Number.isFinite(pages) || pages < 0) {
    throw new Error("Invalid total_pages");
  }

  if (!Number.isInteger(copyCount) || copyCount < 1) {
    throw new Error("Invalid copies");
  }

  if (!Number.isInteger(pagesPerSheet) || pagesPerSheet < 1) {
    throw new Error("Invalid pages_per_sheet");
  }

  // ---------------------------------------------------------
  // Prices
  //
  // bwSingle   = single-sided physical paper
  // bwDouble   = double-sided physical paper
  // colorSingle
  // colorDouble
  // ---------------------------------------------------------

  const prefix = color === "color" ? "color" : "bw";

  const singlePrice = Number(org_price?.[`${prefix}Single`]);
  const doublePrice = Number(org_price?.[`${prefix}Double`]);

  if (!Number.isFinite(singlePrice) || singlePrice < 0) {
    throw new Error(`Price not configured for ${prefix}Single`);
  }

  if (!Number.isFinite(doublePrice) || doublePrice < 0) {
    throw new Error(`Price not configured for ${prefix}Double`);
  }

  // ---------------------------------------------------------
  // Calculate cost for ONE copy
  // ---------------------------------------------------------

  let singleSidedSheets = 0;
  let doubleSidedSheets = 0;

  if (sides === "Two-Sided") {
    /*
     * Number of pages that fit on one physical SIDE.
     *
     * Example:
     * pages = 5
     * pages_per_sheet = 2
     *
     * Front sides:
     *   1,2
     *   5
     *
     * Back sides:
     *   3,4
     *
     * Therefore:
     *   1 double-sided sheet
     *   1 single-sided sheet
     */

    const fullSheets = Math.floor(
      pages / (pagesPerSheet * 2)
    );

    const remainingPages =
      pages % (pagesPerSheet * 2);

    doubleSidedSheets = fullSheets;

    if (remainingPages > 0) {
      if (remainingPages <= pagesPerSheet) {
        // Only one side of the final paper is used.
        singleSidedSheets += 1;
      } else {
        // Both sides of the final paper are used.
        doubleSidedSheets += 1;
      }
    }
  } else {
    /*
     * Single-sided printing.
     *
     * Example:
     * 5 pages / 2 pages per sheet
     *
     * = 3 physical papers
     */

    singleSidedSheets = Math.ceil(
      pages / pagesPerSheet
    );
  }

  // ---------------------------------------------------------
  // Cost for ONE copy
  // ---------------------------------------------------------

  const singleCost =
    singleSidedSheets * singlePrice;

  const doubleCost =
    doubleSidedSheets * doublePrice;

  const costPerCopy =
    singleCost + doubleCost;

  // ---------------------------------------------------------
  // All copies
  // ---------------------------------------------------------

  const totalCost =
    costPerCopy * copyCount;

  return Number(totalCost.toFixed(2));
}

function calculateRefundAmount(print_options, org_price, total_pages, pages_printed) {
  const {
    copies,
    color,
    sides,
    pages_per_sheet
  } = print_options;

  const isColor = color === "color";
  const isDouble = sides === "Two-Sided";

  const priceKey =
    (isColor ? "color" : "bw") +
    (isDouble ? "Double" : "Single");

  if (org_price[priceKey] === undefined) {
    throw new Error(`Price not configured for ${priceKey}`);
  }

  const effectivePagesPerSheet = pages_per_sheet * (isDouble ? 2 : 1);
  const priceInPaise = Math.round(org_price[priceKey] * 100);

  // Total billable pages (including copies)
  const totalBillablePages = total_pages * copies;

  // Printed billable pages
  const printedBillablePages = Math.min(
    pages_printed * copies,
    totalBillablePages
  );

  // Sheets charged
  const totalSheets = Math.ceil(totalBillablePages / effectivePagesPerSheet);
  const printedSheets = Math.ceil(
    printedBillablePages / effectivePagesPerSheet
  );

  const totalAmountPaise = totalSheets * priceInPaise;
  const printedAmountPaise = printedSheets * priceInPaise;

  const refundPaise = Math.max(0, totalAmountPaise - printedAmountPaise);

  return {
    totalAmount: Number((totalAmountPaise / 100).toFixed(2)),
    printedAmount: Number((printedAmountPaise / 100).toFixed(2)),
    refundAmount: Number((refundPaise / 100).toFixed(2)),
    totalSheets,
    printedSheets,
    refundedSheets: totalSheets - printedSheets
  };
}

function calculateEstimatedCostSpiral(
  print_options,
  org_price,
  total_pages,
) {
  const {
    copies,
    sides,
    pages_per_sheet,
    bwlist,
    colorlist
  } = print_options;

  const isDouble = sides === "Two-Sided";
  const effectivePagesPerSheet = pages_per_sheet * (isDouble ? 2 : 1);

  const calculateCost = (pageCount, isColor) => {
    if (pageCount === 0) return 0;

    const priceKey =
      (isColor ? "color" : "bw") +
      (isDouble ? "Double" : "Single");

    if (org_price[priceKey] === undefined) {
      throw new Error(`Price not configured for ${priceKey}`);
    }

    const billablePages = pageCount * copies;
    const sheets = Math.ceil(billablePages / effectivePagesPerSheet);

    const priceInPaise = Math.round(org_price[priceKey] * 100);

    return sheets * priceInPaise;
  };

  const bwPages = bwlist.length;
  const colorPages = colorlist.length;

  // Optional validation
  if (bwPages + colorPages !== total_pages) {
    console.error(
      `Warning: Total pages (${total_pages}) doesn't match bwlist + colorlist (${bwPages + colorPages})`
    );
  }

  const totalInPaise =
    calculateCost(bwPages, false) +
    calculateCost(colorPages, true);

  return Number((totalInPaise / 100).toFixed(2));
}

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
    return []
  }
}

export default async ({ req, res, log, error }) => {
  try {
    /* -------------------------------------------------- */
    /* 1. Enforce POST only */
    /* -------------------------------------------------- */
    if (req.method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405);
    }

    /* -------------------------------------------------- */
    /* 2. TRUST Appwrite identity header */
    /* -------------------------------------------------- */
    const userId = req.headers["x-appwrite-user-id"];
    if (!userId) {
      return res.json({ error: "Unauthorized" }, 401);
    }

    /* -------------------------------------------------- */
    /* 3. Parse body SAFELY */
    /* -------------------------------------------------- */
    let body = {};
    try {
      body = typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
    } catch {
      return res.json({ error: "Invalid JSON body" }, 400);
    }

    log("BODY:", body);

    const path = body.path || "/";

    /* -------------------------------------------------- */
    /* 4. Init Appwrite */
    /* -------------------------------------------------- */
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_PROJECT_ID)
      .setKey(process.env.APPWRITE_SERVER_API_KEY);

    const tablesDB = new TablesDB(client);
    const storage = new Storage(client);
    const messaging = new Messaging(client);
    const users = new Users(client);

    const result = await users.listTargets(userId);

    // Filter only push targets with matching providerId
    const targetIds = result.targets
      .filter(
        target =>
          target.providerType === "push" &&
          target.providerId === "69ea5ef70006eac4b825"
      )
      .map(target => target.$id);
    log(targetIds)
    /* -------------------------------------------------- */
    /* 5. Route: CREATE JOB (WALLET) */
    /* -------------------------------------------------- */
    if (path === "/createJobWallet") {
      const { org_id, file_id, print_options } = body;

      if (!org_id || !file_id || !print_options) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const org_data = await tablesDB.getRow(
        "printa4",
        "shops",
        org_id
      );

      if (!org_data) {
        return res.json({ error: "Organization not found" }, 404);
      }
      log("Organization data:", org_data);
      const printOptionsRaw = body.print_options;
      // Fetch file metadata
      let pageCount;
      if (printOptionsRaw.pages === 'all') {
        pageCount = await getFilePages(userId, file_id, storage);
      } else {
        pageCount = countUniquePages(printOptionsRaw.pages);
      }

      const result = validatePrintOptions(printOptionsRaw);


      if (!result.valid) {
        return res.json({ error: `Missing fields in print_options: ${result.missing.join(", ")}` }, 400);
      }

      const org_price = JSON.parse(org_data.price) || {};
      const estimated_cost = calculateEstimatedCost(
        printOptionsRaw,
        org_price,
        pageCount
      );
      const userDoc = await tablesDB.getRow(
        "printa4",
        "users",
        userId
      );

      if (!userDoc) {
        return res.json({ error: "User not found" }, 404);
      }
      log("User data:", userDoc);

      if ((userDoc.wallet_balance || 0) < estimated_cost) {
        return res.json({ error: "Insufficient wallet balance" }, 400);
      }

      // Deduct wallet balance
      const newBalance = Number(
        ((userDoc.wallet_balance || 0) - estimated_cost).toFixed(2)
      );

      await tablesDB.updateRow(
        "printa4",
        "users",
        userId,
        {
          wallet_balance: newBalance
        }
      );
      if (targetIds.length != 0) {

        await messaging.createPush({
          messageId: "unique()",

          title: "Wallet Debit 💳",
          body: `₹${estimated_cost} deducted from your wallet for print job at ${org_data.name}. New balance: ₹${newBalance}`,

          targets: targetIds, // OR topics / targets

          data: {
            type: "debit",
            amount: String(estimated_cost),
            balance: String(newBalance),
            screen: "wallet"
          },
          tag: `wallet_debit_${userId}_${Date.now()}`,
          priority: MessagePriority.High
        });
      }
      const printOptions = JSON.stringify(printOptionsRaw);
      await storage.updateFile({
        bucketId: userId,
        fileId: file_id,
        permissions: [
          Permission.read(Role.user(org_id)),
          Permission.read(Role.user(userId)),
        ],
      });
      if (print_options.sides === "Two-Sided" && !print_options.duplex_type) {
        print_options.duplex_type = "duplexlong"; // default to long-edge if not specified
      }

      let permissions;

      if (print_options.print_later) {
        permissions = [
          Permission.read(Role.user(userId))
        ]
      } else {
        permissions = [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(org_id)),
          Permission.read(Role.user(org_id)),
        ]
      }
      const job = await tablesDB.createRow(
        "printa4",
        "jobs",
        "unique()",
        {
          user_id: userId,
          org_id,
          session_code: Array.from({ length: 6 }, () =>
            "0123456789"[Math.floor(Math.random() * 10)]
          ).join(""),
          file_name: print_options.file_name || "unknown.pdf",
          print_options: printOptions,
          estimated_cost: estimated_cost,
          refund_status: false,
          payment_status: true,
          print_status: false,
          paid_at: new Date().toISOString(),
          transaction_id: "WALLET-" + String(Date.now()),
          total_pages: pageCount,
          pages_printed: 0,
          file_id,
          payment_method: "wallet",
          payment_message: `Deducted ₹${estimated_cost} from wallet`,
          print_later: print_options.print_later,
          pages_to_print: Math.ceil(pageCount / print_options.pages_per_sheet) * print_options.copies,
          print_message: print_options.print_later
            ? "pending"
            : (org_data.isAutoPrint ? "queued" : "pending")
        },
        permissions
      );
      await tablesDB.createRow("printa4", "verify_orders", job.$id, {
        otp: Array.from({ length: 6 }, () =>
          "0123456789"[Math.floor(Math.random() * 10)]
        ).join("")
      },
        [
          Permission.read(Role.user(userId)),
        ]
      )

      if (!print_options.print_later) {
        if (org_data.isAutoPrint) {
          const capabalePrinters = await findCapablePrinters(org_id, print_options.color, print_options.sides, tablesDB)
          await tablesDB.createRow(
            "printa4",
            "queue",
            job.$id,
            {
              printers: capabalePrinters
            },
            [
              Permission.read(Role.user(org_id)),
              Permission.delete(Role.user(org_id))
            ]
          )
        }
      }

      log(`✅ Job created ${job.$id} for user ${userId}`);
      return res.json(job, 201);
    } else if (path === "/createBlankWalletJob") {
      const { org_id, print_options } = body;

      if (!org_id || !print_options) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const org_data = await tablesDB.getRow(
        "printa4",
        "shops",
        org_id
      );

      if (!org_data) {
        return res.json({ error: "Organization not found" }, 404);
      }
      log("Organization data:", org_data);
      const printOptionsRaw = body.print_options;

      const result = validatePrintOptions(printOptionsRaw);


      if (!result.valid) {
        return res.json({ error: `Missing fields in print_options: ${result.missing.join(", ")}` }, 400);
      }

      const total_pages = printOptionsRaw.total_pages || 1;

      const org_price = JSON.parse(org_data.price) || {};
      const estimated_cost = org_price.blankSheet * total_pages;
      const userDoc = await tablesDB.getRow(
        "printa4",
        "users",
        userId
      );

      if (!userDoc) {
        return res.json({ error: "User not found" }, 404);
      }
      log("User data:", userDoc);

      if ((userDoc.wallet_balance || 0) < estimated_cost) {
        return res.json({ error: "Insufficient wallet balance" }, 400);
      }

      // Deduct wallet balance
      const newBalance = Number(
        ((userDoc.wallet_balance || 0) - estimated_cost).toFixed(2)
      );


      await tablesDB.updateRow(
        "printa4",
        "users",
        userId,
        {
          wallet_balance: newBalance
        }
      );

      const pdfBuffer = await createPdf(total_pages);
      const file = InputFile.fromBuffer(pdfBuffer, "blank.pdf");
      const uploadResponse = await storage.createFile(
        userId,        // bucketId
        "unique()",    // fileId
        file,          // ✅ correct payload
        [
          Permission.read(Role.user(org_id)),
          Permission.read(Role.user(userId)),
        ]
      );

      const file_id = uploadResponse.$id;
      if (targetIds.length != 0) {
        await messaging.createPush({
          messageId: "unique()",

          title: "Wallet Debit 💳",
          body: `₹${estimated_cost} deducted from your wallet for print job at ${org_data.name}. New balance: ₹${newBalance}`,

          targets: targetIds, // OR topics / targets

          data: {
            type: "debit",
            amount: String(estimated_cost),
            balance: String(newBalance),
            screen: "wallet"
          },
          tag: `wallet_debit_${userId}_${Date.now()}`,
          priority: MessagePriority.High
        });
      }
      const printOptions = JSON.stringify(printOptionsRaw);
      await storage.updateFile({
        bucketId: userId,
        fileId: file_id,
        permissions: [
          Permission.read(Role.user(org_id)),
          Permission.read(Role.user(userId)),
        ],
      });
      const job = await tablesDB.createRow(
        "printa4",
        "jobs",
        "unique()",
        {
          user_id: userId,
          org_id,
          session_code: Array.from({ length: 6 }, () =>
            "0123456789"[Math.floor(Math.random() * 10)]
          ).join(""),
          file_name: printOptions.file_name || "blank.pdf",
          print_options: printOptions,
          estimated_cost: estimated_cost,
          refund_status: false,
          payment_status: true,
          print_status: false,
          paid_at: new Date().toISOString(),
          transaction_id: "WALLET-" + String(Date.now()),
          total_pages: total_pages,
          pages_printed: 0,
          file_id,
          payment_method: "wallet",
          payment_message: `Deducted ₹${estimated_cost} from wallet`,
          print_later: false,
          pages_to_print: Math.ceil(total_pages / print_options.pages_per_sheet) * print_options.copies,
          isblanksheet: true,
          print_message: org_data.isAutoPrint ? "queued" : "pending"
        },
        [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(org_id)),
          Permission.read(Role.user(org_id)),
        ]
      );

      await tablesDB.createRow("printa4", "verify_orders", job.$id, {
        otp: Array.from({ length: 6 }, () =>
          "0123456789"[Math.floor(Math.random() * 10)]
        ).join("")
      },
        [
          Permission.read(Role.user(userId)),
        ]
      )
      if (org_data.isAutoPrint) {
        const capabalePrinters = await findCapablePrinters(org_id, false, "One-Sided", tablesDB)
        await tablesDB.createRow(
          "printa4",
          "queue",
          job.$id,
          {
            printers: capabalePrinters
          },
          [
            Permission.read(Role.user(org_id)),
            Permission.delete(Role.user(org_id))
          ]
        )
      }

      log(`✅ Job created ${job.$id} for user ${userId}`);
      return res.json(job, 201);
    } else if (path === "/createBlankJobDirect") {
      const { org_id, print_options } = body;

      if (!org_id || !print_options) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const org_data = await tablesDB.getRow(
        "printa4",
        "shops",
        org_id
      );

      if (!org_data) {
        return res.json({ error: "Organization not found" }, 404);
      }
      log("Organization data:", org_data);
      const printOptionsRaw = body.print_options;

      const result = validatePrintOptions(printOptionsRaw);

      if (!result.valid) {
        return res.json({ error: `Missing fields in print_options: ${result.missing.join(", ")}` }, 400);
      }

      const total_pages = printOptionsRaw.total_pages || 1;

      const org_price = JSON.parse(org_data.price) || {};

      const estimated_cost = org_price.blankSheet * total_pages;

      const pdfBuffer = await createPdf(total_pages);
      const file = InputFile.fromBuffer(pdfBuffer, "blank.pdf");
      const uploadResponse = await storage.createFile(
        userId,        // bucketId
        "unique()",    // fileId
        file,          // ✅ correct payload
        [
          Permission.read(Role.user(org_id)),
          Permission.read(Role.user(userId)),
        ]
      );

      const file_id = uploadResponse.$id;

      const printOptions = JSON.stringify(printOptionsRaw);
      log(`Estimated cost for job: ₹${estimated_cost}`);
      const payment_data = await authorizePayment(
        estimated_cost,
        printOptionsRaw.mobile,
        "print",
        userId
      );

      const transaction = await tablesDB.createRow(
        "printa4",
        "transactions",
        "unique()",
        {
          order_id: payment_data.order_id,
        }
      );

      const job = await tablesDB.createRow(
        "printa4",
        "jobs",
        "unique()",
        {
          user_id: userId,
          org_id,
          session_code: Array.from({ length: 6 }, () =>
            "0123456789"[Math.floor(Math.random() * 10)]
          ).join(""),
          file_name: printOptions.file_name || "blank.pdf",
          print_options: printOptions,
          estimated_cost: estimated_cost,
          refund_status: false,
          payment_status: false,
          print_status: false,
          paid_at: null,
          transaction_id: payment_data.order_id,
          total_pages: total_pages,
          pages_printed: 0,
          file_id,
          payment_method: "upi",
          payment_message: `Payment of ₹${estimated_cost} pending via UPI`,
          print_later: print_options.print_later,
          order_id: transaction.$id,
          pages_to_print: Math.ceil(total_pages / print_options.pages_per_sheet) * print_options.copies,
          isblanksheet: true
        },
        [
          Permission.read(Role.user(userId))
        ]
      );
      await tablesDB.createRow("printa4", "verify_orders", job.$id, {
        otp: Array.from({ length: 6 }, () =>
          "0123456789"[Math.floor(Math.random() * 10)]
        ).join("")
      },
        [
          Permission.read(Role.user(userId)),
        ]
      )

      log(`✅ Job created ${job.$id} for user ${userId}`);
      return res.json(job, 201);
    } else if (path === "/createJobDirect") {
      const { org_id, file_id, print_options } = body;

      if (!org_id || !file_id || !print_options) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const org_data = await tablesDB.getRow(
        "printa4",
        "shops",
        org_id
      );

      if (!org_data) {
        return res.json({ error: "Organization not found" }, 404);
      }
      log("Organization data:", org_data);

      const printOptionsRaw = body.print_options;

      let pageCount;
      if (printOptionsRaw.pages === 'all') {
        pageCount = await getFilePages(userId, file_id, storage);
      } else {
        pageCount = countUniquePages(printOptionsRaw.pages);
      }

      const result = validatePrintOptions(printOptionsRaw);


      if (!result.valid) {
        return res.json({ error: `Missing fields in print_options: ${result.missing.join(", ")}` }, 400);
      }

      const org_price = JSON.parse(org_data.price) || {};
      const estimated_cost = calculateEstimatedCost(
        printOptionsRaw,
        org_price,
        pageCount
      );
      log(`Estimated cost for job: ₹${estimated_cost}`);

      const printOptions = JSON.stringify(printOptionsRaw);
      const payment_data = await authorizePayment(
        estimated_cost,
        printOptionsRaw.mobile,
        "print",
        userId
      );

      const transaction = await tablesDB.createRow(
        "printa4",
        "transactions",
        "unique()",
        {
          order_id: payment_data.order_id,
        }
      );
      if (print_options.sides === "Two-Sided" && !print_options.duplex_type) {
        print_options.duplex_type = "duplexlong"; // default to long-edge if not specified
      }
      log(print_options)
      const job = await tablesDB.createRow(
        "printa4",
        "jobs",
        "unique()",
        {
          user_id: userId,
          org_id,
          session_code: Array.from({ length: 6 }, () =>
            "0123456789"[Math.floor(Math.random() * 10)]
          ).join(""),
          file_name: print_options.file_name || "unknown.pdf",
          print_options: printOptions,
          estimated_cost: estimated_cost,
          refund_status: false,
          payment_status: false,
          print_status: false,
          paid_at: null,
          transaction_id: payment_data.order_id,
          total_pages: pageCount,
          pages_printed: 0,
          file_id,
          payment_method: "upi",
          payment_message: `Payment of ₹${estimated_cost} pending via UPI`,
          print_later: print_options.print_later,
          order_id: transaction.$id,
          pages_to_print: Math.ceil(pageCount / print_options.pages_per_sheet) * print_options.copies
        },
        [
          Permission.read(Role.user(userId))
        ]
      );
      await tablesDB.createRow("printa4", "verify_orders", job.$id, {
        otp: Array.from({ length: 6 }, () =>
          "0123456789"[Math.floor(Math.random() * 10)]
        ).join("")
      },
        [
          Permission.read(Role.user(userId)),
        ]
      )

      log(`✅ Job created ${job.$id} for user ${userId}`);
      return res.json(job, 201);
    } else if (path === "/createSpiralJobDirect") {
      const { org_id, file_id, print_options } = body;

      if (!org_id || !file_id || !print_options) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const org_data = await tablesDB.getRow(
        "printa4",
        "shops",
        org_id
      );

      if (!org_data) {
        return res.json({ error: "Organization not found" }, 404);
      }
      log("Organization data:", org_data);

      const printOptionsRaw = body.print_options;

      let pageCount;
      if (printOptionsRaw.pages === 'all') {
        pageCount = await getFilePages(userId, file_id, storage);
      } else {
        pageCount = countUniquePages(printOptionsRaw.pages);
      }

      const result = validatePrintOptions(printOptionsRaw);


      if (!result.valid) {
        return res.json({ error: `Missing fields in print_options: ${result.missing.join(", ")}` }, 400);
      }

      const org_price = JSON.parse(org_data.price) || {};
      const estimated_cost = calculateEstimatedCostSpiral(
        printOptionsRaw,
        org_price,
        pageCount
      ) + org_data.spiral_price;
      log(`Estimated cost for job: ₹${estimated_cost}`);

      const printOptions = JSON.stringify(printOptionsRaw);

      const response = await fetch("https://conv.printa4.in/convert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          "bucket_id": userId,
          "file_id": file_id,
          "color_pages": printOptionsRaw.colorlist,
          "bw_pages": printOptionsRaw.bwlist
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const payment_data = await authorizePayment(
        estimated_cost,
        printOptionsRaw.mobile,
        "print",
        userId
      );

      const transaction = await tablesDB.createRow(
        "printa4",
        "transactions",
        "unique()",
        {
          order_id: payment_data.order_id,
        }
      );
      if (print_options.sides === "Two-Sided" && !print_options.duplex_type) {
        print_options.duplex_type = "duplexlong"; // default to long-edge if not specified
      }
      log(print_options)
      const job = await tablesDB.createRow(
        "printa4",
        "jobs",
        "unique()",
        {
          user_id: userId,
          org_id,
          session_code: Array.from({ length: 6 }, () =>
            "0123456789"[Math.floor(Math.random() * 10)]
          ).join(""),
          file_name: print_options.file_name || "unknown.pdf",
          print_options: printOptions,
          estimated_cost: estimated_cost,
          refund_status: false,
          payment_status: false,
          print_status: false,
          paid_at: null,
          transaction_id: payment_data.order_id,
          total_pages: pageCount,
          pages_printed: 0,
          file_id,
          payment_method: "upi",
          payment_message: `Payment of ₹${estimated_cost} pending via UPI`,
          print_later: print_options.print_later,
          order_id: transaction.$id,
          pages_to_print: Math.ceil(pageCount / print_options.pages_per_sheet) * print_options.copies
        },
        [
          Permission.read(Role.user(userId))
        ]
      );

      await tablesDB.createRow("printa4", "verify_orders", job.$id, {
        otp: Array.from({ length: 6 }, () =>
          "0123456789"[Math.floor(Math.random() * 10)]
        ).join("")
      },
        [
          Permission.read(Role.user(userId)),
        ]
      )

      log(`✅ Job created ${job.$id} for user ${userId}`);
      return res.json(job, 201);
    } else if (path === "/createSpiralJobWallet") {
      const { org_id, file_id, print_options } = body;

      if (!org_id || !file_id || !print_options) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const org_data = await tablesDB.getRow(
        "printa4",
        "shops",
        org_id
      );

      if (!org_data) {
        return res.json({ error: "Organization not found" }, 404);
      }
      log("Organization data:", org_data);
      const printOptionsRaw = body.print_options;
      // Fetch file metadata
      let pageCount;
      if (printOptionsRaw.pages === 'all') {
        pageCount = await getFilePages(userId, file_id, storage);
      } else {
        pageCount = countUniquePages(printOptionsRaw.pages);
      }

      const result = validatePrintOptions(printOptionsRaw);

      if (!result.valid) {
        return res.json({ error: `Missing fields in print_options: ${result.missing.join(", ")}` }, 400);
      }

      const org_price = JSON.parse(org_data.price) || {};

      const estimated_cost = calculateEstimatedCostSpiral(
        printOptionsRaw,
        org_price,
        pageCount
      ) + org_data.spiral_price;

      const userDoc = await tablesDB.getRow(
        "printa4",
        "users",
        userId
      );

      if (!userDoc) {
        return res.json({ error: "User not found" }, 404);
      }
      log("User data:", userDoc);

      if ((userDoc.wallet_balance || 0) < estimated_cost) {
        return res.json({ error: "Insufficient wallet balance" }, 400);
      }

      const response = await fetch("https://conv.printa4.in/convert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          "bucket_id": userId,
          "file_id": file_id,
          "color_pages": printOptionsRaw.colorlist,
          "bw_pages": printOptionsRaw.bwlist
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      // Deduct wallet balance
      const newBalance = Number(
        ((userDoc.wallet_balance || 0) - estimated_cost).toFixed(2)
      );

      await tablesDB.updateRow(
        "printa4",
        "users",
        userId,
        {
          wallet_balance: newBalance
        }
      );
      if (targetIds.length != 0) {

        await messaging.createPush({
          messageId: "unique()",

          title: "Wallet Debit 💳",
          body: `₹${estimated_cost} deducted from your wallet for print job at ${org_data.name}. New balance: ₹${newBalance}`,

          targets: targetIds, // OR topics / targets

          data: {
            type: "debit",
            amount: String(estimated_cost),
            balance: String(newBalance),
            screen: "wallet"
          },
          tag: `wallet_debit_${userId}_${Date.now()}`,
          priority: MessagePriority.High
        });
      }
      const printOptions = JSON.stringify(printOptionsRaw);
      await storage.updateFile({
        bucketId: userId,
        fileId: file_id,
        permissions: [
          Permission.read(Role.user(org_id)),
          Permission.read(Role.user(userId)),
        ],
      });
      if (print_options.sides === "Two-Sided" && !print_options.duplex_type) {
        print_options.duplex_type = "duplexlong"; // default to long-edge if not specified
      }

      let permissions;

      if (print_options.print_later) {
        permissions = [
          Permission.read(Role.user(userId))
        ]
      } else {
        permissions = [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(org_id)),
          Permission.read(Role.user(org_id)),
        ]
      }
      const job = await tablesDB.createRow(
        "printa4",
        "jobs",
        "unique()",
        {
          user_id: userId,
          org_id,
          session_code: Array.from({ length: 6 }, () =>
            "0123456789"[Math.floor(Math.random() * 10)]
          ).join(""),
          file_name: print_options.file_name || "unknown.pdf",
          print_options: printOptions,
          estimated_cost: estimated_cost,
          refund_status: false,
          payment_status: true,
          print_status: false,
          paid_at: new Date().toISOString(),
          transaction_id: "WALLET-" + String(Date.now()),
          total_pages: pageCount,
          pages_printed: 0,
          file_id,
          payment_method: "wallet",
          payment_message: `Deducted ₹${estimated_cost} from wallet`,
          print_later: print_options.print_later,
          pages_to_print: Math.ceil(pageCount / print_options.pages_per_sheet) * print_options.copies,
          print_message: print_options.print_later
            ? "pending"
            : (org_data.isAutoPrint ? "queued" : "pending")
        },
        permissions
      );

      await tablesDB.createRow("printa4", "verify_orders", job.$id, {
        otp: Array.from({ length: 6 }, () =>
          "0123456789"[Math.floor(Math.random() * 10)]
        ).join("")
      },
        [
          Permission.read(Role.user(userId)),
        ]
      )

      if (!print_options.print_later) {
        if (org_data.isAutoPrint) {
          const capabalePrinters = await findCapablePrinters(org_id, print_options.color, print_options.sides, tablesDB)
          await tablesDB.createRow(
            "printa4",
            "queue",
            job.$id,
            {
              printers: capabalePrinters
            },
            [
              Permission.read(Role.user(org_id)),
              Permission.delete(Role.user(org_id))
            ]
          )
        }
      }

      log(`✅ Job created ${job.$id} for user ${userId}`);
      return res.json(job, 201);
    } else if (path === "/refundJob") {
      const { job_id, reason } = body;

      if (!job_id) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const job = await tablesDB.getRow(
        "printa4",
        "jobs",
        job_id
      );

      if (!job) {
        return res.json({ error: "Job not found" }, 404);
      }

      if (job.user_id !== userId) {
        return res.json({ error: "Unauthorized to refund this job" }, 403);
      }

      if (job.refund_status) {
        return res.json({ error: "Job already refunded" }, 400);
      }

      if (!job.payment_status) {
        return res.json({ error: "Cannot refund a job that has not been paid" }, 400);
      }


      if (job.print_completed) {
        return res.json({ error: "print is already completed" }, 400)
      }

      const updatedAt = new Date(job.$updatedAt);
      const now = new Date();

      const diffInMs = now - updatedAt;
      const threeMinutes = 3 * 60 * 1000;

      if (job.print_status && diffInMs < threeMinutes) {
        return res.json({ error: "Cannot refund a job that has been printed or is in progress" }, 400);
      }

      // Process refund logic here (e.g., via payment gateway API)
      const userDoc = await tablesDB.getRow(
        "printa4",
        "users",
        userId
      );

      const org_data = await tablesDB.getRow(
        "printa4",
        "shops",
        job.org_id
      );
      // Update job refund status
      await tablesDB.updateRow(
        "printa4",
        "jobs",
        job_id,
        {
          refund_status: true,
          reason: reason || "No reason provided"
        }
      );
      let refundAmt = 0;
      const org_price = JSON.parse(org_data.price) || {};
      if (job.isblanksheet) {
        const remainPage = job.pages_to_print - job.pages_printed
        refundAmt = org_price.blankSheet * remainPage
      } else {
        const estimated_cost = calculateRefundAmount(
          JSON.parse(job.print_options),
          org_price,
          job.total_pages,
          job.pages_printed
        );
        refundAmt = estimated_cost.refundAmount;
      }
      await tablesDB.updateRow(
        "printa4",
        "users",
        userId,
        {
          wallet_balance: Number(
            ((userDoc.wallet_balance || 0) + refundAmt).toFixed(2)
          )
        }
      );
      try {
        await tablesDB.deleteRow(
          "printa4",
          "queue",
          job_id
        )
      } catch {

      }
      log(`✅ Job ${job_id} refunded for user ${userId}`);
      const result = await tablesDB.listRows(
        "printa4",
        "jobs",
        [
          Query.equal("org_id", job.org_id),
          Query.orderDesc("$createdAt"),
          Query.limit(5)
        ]
      );

      const allRefunded =
        result.rows.length === 5 &&
        result.rows.every(job => job.refund_status === true);
      if (allRefunded) {
        const func = new Functions(client);
        const result = await func.createExecution({
          functionId: '69b23aa80036dd360497',
          body: JSON.stringify({
            ip: "192.168.1.1",
            errorFlags: ["highRefund"],
            shopID: job.org_id,
            isError: true,
          }),
        });
      }
      if (targetIds.length != 0) {
        await messaging.createPush({
          messageId: "unique()",

          title: "Refund Successful 💳",
          body: `₹${refundAmt} refunded to your wallet for print job at ${job.session_code}. New balance: ₹${((userDoc.wallet_balance || 0) + refundAmt).toFixed(2)}`,

          targets: targetIds, // OR topics / targets


          data: {
            type: "credit",
            amount: String(refundAmt),
            balance: String(((userDoc.wallet_balance || 0) + refundAmt).toFixed(2)),
            screen: "wallet"
          },
          tag: `wallet_credit_${userId}_${Date.now()}`,
          priority: MessagePriority.High
        });
      }
      return res.json({ success: true, message: "Job refunded successfully" }, 200);
    }
    else if (path === "/walletTopUp") {
      const { amount } = body;

      if (!amount || isNaN(amount) || amount <= 0) {
        return res.json({ error: "Invalid amount" }, 400);
      }

      const payment_data = await authorizePayment(
        amount,
        body.mobile || "",
        "wallet",
        userId
      );

      await tablesDB.createRow(
        "printa4",
        "transactions",
        "unique()",
        {
          order_id: payment_data.order_id,
        }
      );

      return res.json(payment_data, 200);
    } else if (path === "/reprintJob") {
      const { job_id } = body;

      if (!job_id) {
        return res.json({ error: "Missing required fields" }, 400);
      }

      const job = await tablesDB.getRow(
        "printa4",
        "jobs",
        job_id
      );

      const org_data = await tablesDB.getRow("printa4", "shops", job.org_id)

      if (!job) {
        return res.json({ error: "Job not found" }, 404);
      }

      if (job.user_id !== userId) {
        return res.json({ error: "Unauthorized to reprint this job" }, 403);
      }

      if (!job.payment_status) {
        return res.json({ error: "Cannot reprint a job that has not been paid" }, 400);
      }

      if (!job.print_message === "processing" || !job.print_message === "printed") {
        return res.json({ error: "Can only reprint a job that hasn't been printed" }, 400);
      }

      if (!isMoreThan10Minutes(job.paid_at)) {
        return res.json({ error: "Reprint window has not expired (10 minutes)" }, 400);
      }
      if (targetIds.length != 0) {
        await messaging.createPush({
          messageId: "unique()",
          title: "Reprint Requested 🔄",
          body: `Your reprint request for job ${job.session_code} has been received. We will notify you once it's ready.`,

          targets: targetIds, // OR topics / targets

          data: {
            type: "reprint_request",
            job_id,
            screen: "jobs"
          },
          tag: `reprint_request_${userId}_${Date.now()}`,
          priority: MessagePriority.High
        });
      }
      const printOptions = JSON.parse(job.print_options);
      const new_job = await tablesDB.createRow(
        "printa4",
        "jobs",
        "unique()",
        {
          user_id: job.user_id,
          org_id: job.org_id,
          session_code: job.session_code + "R",
          file_name: job.file_name,
          print_options: job.print_options,
          estimated_cost: 0, // No cost for reprint
          refund_status: false,
          payment_status: true,
          print_status: false,
          paid_at: new Date().toISOString(),
          transaction_id: job.transaction_id + "-REPRINT-" + Date.now(),
          total_pages: job.total_pages,
          pages_printed: 0,
          file_id: job.file_id,
          payment_method: job.payment_method,
          payment_message: `Reprint of job ${job.$id}`,
          print_later: false,
          pages_to_print: Math.ceil(job.total_pages / printOptions.pages_per_sheet) * printOptions.copies,
          print_message: org_data.isAutoPrint ? "queued" : "pending"
        },
        [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(job.org_id)),
          Permission.read(Role.user(job.org_id)),
        ]
      );

      if (org_data.isAutoPrint) {
        const capabalePrinters = await findCapablePrinters(job.org_id, printOptions.color, printOptions.sides, tablesDB)
        await tablesDB.createRow(
          "printa4",
          "queue",
          new_job.$id,
          {
            printers: capabalePrinters
          },
          [
            Permission.read(Role.user(job.org_id)),
            Permission.delete(Role.user(job.org_id))
          ]
        )
      }
      await tablesDB.updateRow(
        "printa4",
        "jobs",
        job_id,
        {
          print_message: "reprint_requested",
          print_status: true

        }
      );
      log(`✅ Reprint job created for original job ${job_id} for user ${userId}`);
      return res.json({ success: true, message: "Reprint job created successfully" }, 201);
    } else if (path === "/printNow") {
      const { job_id } = body;
      const docData = await tablesDB.getRow(
        "printa4",
        "jobs",
        job_id
      )
      if (
        docData.user_id === userId &&
        docData.payment_status === true &&
        docData.refund_status !== true
      ) {

        const printOptions = JSON.parse(docData.print_options);
        const org_data = await tablesDB.getRow("printa4", "shops", docData.org_id)
        const capabalePrinters = await findCapablePrinters(docData.org_id, printOptions.color, printOptions.sides, tablesDB)
        await tablesDB.updateRow(
          "printa4",
          "jobs",
          job_id,
          {
            print_message: org_data.isAutoPrint ? "queued" : "pending"
          },
          [
            Permission.read(Role.user(userId)),
            Permission.update(Role.user(docData.org_id)),
            Permission.read(Role.user(docData.org_id)),
          ]
        );

        if (org_data.isAutoPrint) {
          await tablesDB.createRow(
            "printa4",
            "queue",
            docData.$id,
            {
              printers: capabalePrinters
            },
            [
              Permission.read(Role.user(docData.org_id)),
              Permission.delete(Role.user(docData.org_id))
            ]
          )
        }

        return res.json({ success: true, message: `Printing job with session code: ${docData.session_code}` }, 201)
      } else {
        return res.json({ success: false, message: "either job is not belong to user or refunded or payment not done" }, 401)
      }
    } else if (path === "/createTemp") {
      const { shopId, domain } = body;
      if (!shopId) {
        return res.json({ error: "shopId missing" }, 401)
      }
      try {
        // 1. check if doc exists
        try {
          const existing = await tablesDB.getRow(
            "printa4",
            "temp",
            userId
          );
          await tablesDB.updateRow(
            "printa4",
            "temp",
            userId,
            {
              shopId,
              domain
            }
          )

          return res.json({
            data: existing,
          });
        } catch (err) {
          // not found → continue
        }

        // 2. generate session id
        const sessionId = generateSessionId();

        // 3. create bucket (⚠️ not recommended at scale)
        const bucket = await storage.createBucket(
          `bucket_${userId}`,
          `Temp Bucket ${userId}`,
          [
            Permission.read(Role.user(userId)),
            Permission.delete(Role.user(userId)),
          ],
          false,
          true,
          undefined,
        );

        // 4. create document
        const doc = await tablesDB.createRow(
          "printa4",
          "temp",
          userId,
          {
            sessionId,
            bucketID: bucket.$id,
            shopId,
            domain
          }
        );

        return res.json({
          data: doc,
        });
      } catch (e) {
        error(e);
        return res.json(
          {
            error: e.message,
          },
          500
        );
      }
    }
    return res.json({ error: "Invalid path" }, 400);

  } catch (err) {
    error(err);
    return res.json({ error: "Internal server error" }, 500);
  }
};