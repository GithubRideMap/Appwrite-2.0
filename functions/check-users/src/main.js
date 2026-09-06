
import {
  Client,
  Storage,
  TablesDB,
  Query,
  Role,
  Permission,
  Users,
} from "node-appwrite";

const APPWRITE_SERVER_ENDPOINT =
  process.env.APPWRITE_SERVER_ENDPOINT;

const APPWRITE_PROJECT_ID =
  process.env.APPWRITE_PROJECT_ID;

const APPWRITE_SERVER_API_KEY =
  process.env.APPWRITE_SERVER_API_KEY;

const DATABASE_ID = "printa4";
const USERS_TABLE = "users";

const CHECK_LIMIT = 25;

export default async ({ req, res, log, error }) => {
  try {
    const client = new Client()
      .setEndpoint(APPWRITE_SERVER_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID)
      .setKey(APPWRITE_SERVER_API_KEY);

    const databases = new TablesDB(client);
    const storage = new Storage(client);
    const users = new Users(client);

    // =========================================================
    // 1. SYNC NEW AUTH USERS → USERS TABLE
    //
    // Only fetch the latest 25 Auth users.
    // =========================================================

    const authResult = await users.list({
      queries: [
        Query.orderDesc("$createdAt"),
        Query.limit(25),
      ],
      total: false,
    });

    log(
      `Checking ${authResult.users.length} latest Auth users`
    );

    for (const authUser of authResult.users) {
      try {
        await databases.getRow(
          DATABASE_ID,
          USERS_TABLE,
          authUser.$id
        );

        // Row already exists
      } catch (err) {

        if (err.code !== 404) {
          error(
            `Failed checking user row ${authUser.$id}: ${err.message}`
          );
          continue;
        }

        // =====================================================
        // USER DOES NOT EXIST → CREATE
        // =====================================================

        try {
          await databases.createRow(
            DATABASE_ID,
            USERS_TABLE,
            authUser.$id,
            {
              email: authUser.email || "",
              phone: authUser.phone || "",
              name: authUser.name || "",

              wallet_balance: 0,
              razorpay_id: "",
              isVip: false,
              vipWaitlist: false,

              // Important:
              // This puts the user into the validation queue.
              isValidated: false,
            },
            [
              Permission.read(
                Role.user(authUser.$id)
              ),
            ]
          );

          log(
            `Created users row for new Auth user: ${authUser.$id}`
          );

        } catch (createErr) {

          // Another execution may have created it
          if (createErr.code === 409) {
            log(
              `User row already exists: ${authUser.$id}`
            );
          } else {
            error(
              `Failed creating user row ${authUser.$id}: ${createErr.message}`
            );
          }
        }
      }
    }

    // =========================================================
    // 2. GET ONLY 25 UNVALIDATED USERS
    //
    // Once a user is successfully processed we set:
    //
    //     isValidated = true
    //
    // Therefore they won't appear on the next execution.
    // =========================================================

    const pendingResult = await databases.listRows(
      DATABASE_ID,
      USERS_TABLE,
      [
        Query.equal("isValidated", false),
        Query.limit(CHECK_LIMIT),
        Query.orderAsc("$createdAt"),
      ]
    );

    const pendingUsers =
      pendingResult.rows ||
      pendingResult.documents ||
      [];

    log(
      `Found ${pendingUsers.length} unvalidated users`
    );

    // =========================================================
    // 3. PROCESS MAXIMUM 25 USERS
    // =========================================================

    let processed = 0;
    let failed = 0;

    for (const user of pendingUsers) {
      const userId = user.$id;

      log(
        `Processing ${userId} (${user.email || "no email"})`
      );

      try {

        // =====================================================
        // A. CHECK AUTH USER
        // =====================================================

        let authUser;

        try {
          authUser = await users.get({
            userId,
          });

          log(
            `Auth user exists: ${userId}`
          );

        } catch (err) {

          if (err.code === 404) {

            // Auth user does not exist.
            // Do NOT mark validated.
            // It will remain in the queue.
            log(
              `Auth user missing: ${userId}`
            );

            failed++;
            continue;
          }

          throw err;
        }

        // =====================================================
        // B. ENSURE STORAGE BUCKET
        // =====================================================

        let bucketExists = false;

        try {
          await storage.getBucket({
            bucketId: userId,
          });

          bucketExists = true;

          log(
            `Bucket exists: ${userId}`
          );

        } catch (err) {

          if (err.code !== 404) {
            throw err;
          }
        }

        // =====================================================
        // C. CREATE BUCKET IF MISSING
        // =====================================================

        if (!bucketExists) {

          try {
            await storage.createBucket(
              userId,
              `user-${userId}`,

              [
                Permission.read(
                  Role.user(userId)
                ),

                Permission.create(
                  Role.user(userId)
                ),

                Permission.read(
                  Role.team("shop_owners")
                ),
              ],

              true, // fileSecurity
              true, // enabled
              undefined,
              ["pdf"]
            );

            log(
              `Created bucket: ${userId}`
            );

          } catch (err) {

            // Bucket may have been created by
            // another concurrent execution.
            if (err.code === 409) {
              log(
                `Bucket already exists: ${userId}`
              );
            } else {
              throw err;
            }
          }
        }

        // =====================================================
        // D. EVERYTHING IS READY
        //
        // Only now mark isValidated=true.
        // =====================================================

        await databases.updateRow(
          DATABASE_ID,
          USERS_TABLE,
          userId,
          {
            isValidated: true,
          }
        );

        processed++;

        log(
          `✓ User completed: ${userId}`
        );

      } catch (err) {

        failed++;

        // IMPORTANT:
        // Don't set isValidated=true on failure.
        //
        // It remains false and will be retried
        // during the next scheduled execution.

        error(
          `Failed processing ${userId}: ${err.message}`
        );
      }
    }

    // =========================================================
    // 4. RESULT
    // =========================================================

    log("");
    log("========================================");
    log("RECONCILIATION COMPLETED");
    log("========================================");

    log(`Pending checked : ${pendingUsers.length}`);
    log(`Processed       : ${processed}`);
    log(`Failed          : ${failed}`);

    return res.json({
      status: true,

      checked: pendingUsers.length,
      processed,
      failed,
    });

  } catch (err) {

    error(
      `Function failed: ${err.message || String(err)}`
    );

    return res.json(
      {
        status: false,
        message: err.message || String(err),
      },
      500
    );
  }
};
