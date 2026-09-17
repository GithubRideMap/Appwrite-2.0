import {
    Client,
    TablesDB,
    Permission,
    Role,
    Storage,
    Messaging,
    MessagePriority,
    Query,
    Users
} from "node-appwrite";

import { send_welcome } from "./welcome.js";
import { handle_default } from "./default.js";
import { handle_document } from "./documents.js";
import { sendtyping } from "./send.js";
import { handle_button } from "./button.js";

async function handleWebhook(
    req,
    res,
    log,
    error,
    tablesDB,
    storage,
    messaging,
    users
) {
    try {

        log(req.body);

        const value =
            req.body?.entry?.[0]?.changes?.[0]?.value;

        // Incoming message webhook
        log(value);

        if (value?.messages?.length) {

            const message = value.messages[0];

            await sendtyping(message.id);

            switch (message.type) {

                case "text":

                    await send_welcome(
                        message,
                        req,
                        res,
                        log,
                        error,
                        tablesDB,
                        storage,
                        messaging,
                        users
                    );

                    break;

                case "document":
                case "image":

                    await handle_document(
                        message,
                        req,
                        res,
                        log,
                        error,
                        tablesDB,
                        storage,
                        messaging,
                        users
                    );

                    break;

                case "button":

                    await handle_button(
                        message,
                        req,
                        res,
                        log,
                        error,
                        tablesDB,
                        storage,
                        messaging,
                        users
                    );

                    break;

                default:

                    await handle_default(
                        message,
                        req,
                        res,
                        log,
                        error,
                        tablesDB,
                        storage,
                        messaging,
                        users
                    );

                    break;
            }
        }

    } catch (err) {
        error("Webhook error:", err);
    }
}

export default async ({ req, res, log, error }) => {

    try {

        // Appwrite setup
        const client = new Client()
            .setEndpoint(
                process.env.APPWRITE_FUNCTION_API_ENDPOINT
            )
            .setProject(
                process.env.APPWRITE_PROJECT_ID
            )
            .setKey(
                process.env.APPWRITE_SERVER_API_KEY
            );

        // WhatsApp Cloud API verification
        if (req.method === "GET") {

            const mode =
                req.query["hub.mode"];

            const token =
                req.query["hub.verify_token"];

            const challenge =
                req.query["hub.challenge"];

            const VERIFY_TOKEN =
                process.env.WHATSAPP_VERIFY_TOKEN;

            if (
                mode === "subscribe" &&
                token === VERIFY_TOKEN
            ) {

                log(
                    "Webhook verified successfully"
                );

                return res.send(
                    challenge,
                    200
                );
            }

            error(
                "Webhook verification failed"
            );

            return res.send(
                "Forbidden",
                403
            );
        }

        // WhatsApp webhook events
        if (req.method === "POST") {

            log(
                "Received WhatsApp webhook event"
            );

            const tablesDB =
                new TablesDB(client);

            const storage =
                new Storage(client);

            const messaging =
                new Messaging(client);

            const users =
                new Users(client);

            await handleWebhook(
                req,
                res,
                log,
                error,
                tablesDB,
                storage,
                messaging,
                users
            );

            return res.json({
                success: true,
                received: req.body,
            });
        }

        return res.send(
            "Method Not Allowed",
            405
        );

    } catch (err) {

        error(
            err?.stack ||
            err?.message ||
            String(err)
        );

        return res.json(
            {
                success: false,
                error: err.message,
            },
            500
        );
    }
};
