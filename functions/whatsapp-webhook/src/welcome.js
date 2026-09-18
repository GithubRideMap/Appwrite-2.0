import { Query } from "node-appwrite";
import OpenAI from "openai";
import {
    sendWhatsAppMessage,
    sendTemplate
} from "./send.js";

export async function send_welcome(
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

    const message_text = message.text.body;

    const match =
        message_text.match(/:\s*([A-Z0-9]+)/);

    if (match) {

        const result = await tablesDB.listRows(
            "printa4",
            "temp",
            [
                Query.equal(
                    "sessionId",
                    match[1]
                )
            ]
        );

        const doc = result.rows[0];

        if (doc) {

            await tablesDB.updateRow(
                "printa4",
                "temp",
                doc.$id,
                {
                    phone: from
                }
            );

            const shopdoc =
                await tablesDB.getRow(
                    "printa4",
                    "shops",
                    doc.shopId
                );

            await sendTemplate({
                to: from,
                templateName: "welcome_upload",
                bodyParams: [
                    shopdoc.name
                ]
            });

        } else {

            await sendWhatsAppMessage(
                from,
                "Invalid Session Code"
            );
        }

    } else if (message_text === "Completed") {

        const result =
            await tablesDB.listRows(
                "printa4",
                "temp",
                [
                    Query.orderDesc(
                        "$updatedAt"
                    ),
                    Query.equal(
                        "phone",
                        from
                    )
                ]
            );

        const doc = result.rows[0];

        await sendWhatsAppMessage(
            from,
            `✅ We've received your files successfully.

Happy printing with PrintA4.in! 🎉

Click the link below to start Printing :

🔗 https://printa4.in/print?orgId=${doc.shopId}`
        );
    }
}
