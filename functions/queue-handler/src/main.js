import {
    Client,
    TablesDB,
    Permission,
    Role,
    Storage,
    Users,
    Messaging,
    MessagePriority
} from "node-appwrite";

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

    const effectivePagesPerSheet =
        pages_per_sheet * (isDouble ? 2 : 1);

    const priceInPaise =
        Math.round(org_price[priceKey] * 100);

    // Total billable pages (including copies)
    const totalBillablePages =
        total_pages * copies;

    // Printed billable pages
    const printedBillablePages = Math.min(
        pages_printed * copies,
        totalBillablePages
    );

    // Sheets charged
    const totalSheets =
        Math.ceil(
            totalBillablePages / effectivePagesPerSheet
        );

    const printedSheets =
        Math.ceil(
            printedBillablePages / effectivePagesPerSheet
        );

    const totalAmountPaise =
        totalSheets * priceInPaise;

    const printedAmountPaise =
        printedSheets * priceInPaise;

    const refundPaise =
        Math.max(
            0,
            totalAmountPaise - printedAmountPaise
        );

    return {
        totalAmount: Number(
            (totalAmountPaise / 100).toFixed(2)
        ),
        printedAmount: Number(
            (printedAmountPaise / 100).toFixed(2)
        ),
        refundAmount: Number(
            (refundPaise / 100).toFixed(2)
        ),
        totalSheets,
        printedSheets,
        refundedSheets: totalSheets - printedSheets
    };
}

// This Appwrite function will be executed every time your function is triggered
export default async ({ req, res, log, error }) => {
    try {

        const client = new Client()
            .setEndpoint(
                process.env.APPWRITE_FUNCTION_API_ENDPOINT
            )
            .setProject(
                process.env.APPWRITE_FUNCTION_PROJECT_ID
            )
            .setKey(
                process.env.APPWRITE_SERVER_API_KEY
            );

        const tablesDB = new TablesDB(client);
        const storage = new Storage(client);
        const users = new Users(client);
        const messaging = new Messaging(client);

        log(req);

        const data = req.bodyJson;

        const printId = data?.printId;

        if (printId && printId.length > 2) {

            const jobData = await tablesDB.getRow(
                "printa4",
                "jobs",
                printId
            );

            if (!jobData.isCredited) {

                try {

                    log(`Crediting job: ${printId}`);

                    let creditAmount = 0;

                    const userDoc = await tablesDB.getRow(
                        "printa4",
                        "users",
                        jobData.org_id
                    );

                    if (
                        jobData.pages_to_print !=
                        jobData.pages_printed
                    ) {

                        const org_data =
                            await tablesDB.getRow(
                                "printa4",
                                "shops",
                                jobData.org_id
                            );

                        const org_price =
                            JSON.parse(org_data.price) || {};

                        if (jobData.isblanksheet) {

                            creditAmount = Number(
                                (
                                    (
                                        jobData.pages_printed *
                                        org_price.blankSheet
                                    ) * 0.97
                                ).toFixed(2)
                            );

                        } else {

                            const estimated_cost =
                                calculateRefundAmount(
                                    JSON.parse(
                                        jobData.print_options
                                    ),
                                    org_price,
                                    jobData.total_pages,
                                    jobData.pages_printed
                                );

                            creditAmount = Number(
                                (
                                    estimated_cost.printedAmount *
                                    0.97
                                ).toFixed(2)
                            );
                        }

                    } else {

                        creditAmount = Number(
                            (
                                jobData.estimated_cost *
                                0.97
                            ).toFixed(2)
                        );
                    }

                    // Add credit to existing balance
                    const updatedBalance = Number(
                        (
                            userDoc.wallet_balance +
                            creditAmount
                        ).toFixed(2)
                    );

                    await tablesDB.updateRow(
                        "printa4",
                        "users",
                        jobData.org_id,
                        {
                            wallet_balance: updatedBalance,
                        }
                    );

                    // Mark job as credited
                    await tablesDB.updateRow(
                        "printa4",
                        "jobs",
                        printId,
                        {
                            isCredited: true,
                        },
                        [
                            Permission.read(
                                Role.user(jobData.user_id)
                            ),
                            Permission.read(
                                Role.user(jobData.org_id)
                            ),
                        ]
                    );

                    // Remove file permissions
                    await storage.updateFile({
                        bucketId: jobData.user_id,
                        fileId: jobData.file_id,
                        permissions: [],
                    });

                    const userInfo = await users.get({
                        userId: jobData.user_id
                    });

                    const result =
                        await users.listTargets(
                            jobData.user_id
                        );

                    // Filter only push targets with matching providerId
                    const targetIds = result.targets
                        .filter(
                            target =>
                                target.providerType === "push" &&
                                target.providerId ===
                                    "69ea5ef70006eac4b825"
                        )
                        .map(
                            target => target.$id
                        );

                    try {

                        await messaging.createPush({
                            messageId: "unique()",
                            title: "Print Job Completed ✅",
                            body: `${userInfo.name}, your print job ${jobData.session_code} is complete.

Printed ${jobData.pages_printed}/${jobData.pages_to_print} pages.
Tap to leave a review ⭐`,
                            targets: targetIds,
                            data: {
                                url: "https://g.page/r/CZ_hcgr1K7F0EAE/review"
                            },
                            action: "open_review",
                            tag: "print_completed",
                            priority: MessagePriority.High
                        });

                    } catch {}

                    log(
                        `Successfully credited ₹${creditAmount} to ${jobData.org_id}`
                    );

                } catch (error) {

                    log(
                        "Failed to credit wallet:",
                        error
                    );

                    throw error;
                }
            }
        }

        return res.json({
            motto: "Build like a team of hundreds_",
            learn: "https://appwrite.io/docs",
            connect: "https://appwrite.io/discord",
            getInspired: "https://builtwith.appwrite.io",
        });

    } catch {

        return res.json({
            success: false
        });
    }
};
