import { Query } from "node-appwrite";

import { sendWhatsAppMessage, sendTemplate } from "./send.js";

export async function handle_button(
    message,
    req,
    res,
    log,
    error,
    tablesDB,
    storage,
    messaging,
    users
) {
    const from = message.from;

    const button = message.button;

    if (button.payload === "Completed") {

        const result = await tablesDB.listRows(
            "printa4",
            "temp",
            [
                Query.orderDesc("$updatedAt"),
                Query.equal("phone", from)
            ]
        );

        const doc = result.rows[0];

        const domain = doc.domain || "printa4.in";

        await sendWhatsAppMessage(
            from,
            `✅ We've received your files successfully.

Happy printing with ${domain}! 🎉

Click the link below to start Printing :

🔗 https://${domain}/print?orgId=${doc.shopId}`
        );

    } else {

        await sendWhatsAppMessage(
            from,
            "Please send your session Code"
        );
    }
}
