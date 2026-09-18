import { Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

const ACCESS_TOKEN =
    process.env.WHATSAPP_ACCESS_TOKEN ||
    "EAAxE2T0i6wkBRhFF2oKgqX45DyI1owCdUXMVjfp7hnyWclhh5NfsWp9mspSCwFvdarLXf9DGGzlHH3U2tVriB8FPeRr7ZB9SPpsvfdMHXgX8XiNioOF5vqjp4mm4pvXnnR0Czdb5HSUvJdFTSrLT7ZCL3iB0yVCGmcuWXElo46KcvuXiF5VxIN56ZBezDO1DAZDZD";

const ALLOWED_MIME_TYPES = new Set([
    // Images
    "image/jpeg",
    "image/png",
    "image/jpg",

    // PDF
    "application/pdf",

    // Word
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

    // PowerPoint
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",

    // Excel
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

    // Text
    "text/plain"
]);

export async function handle_document(
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
    try {

        const media = message.document || message.image;

        if (!media) {
            return;
        }

        const mimeType_temp = media.mime_type;

        if (!ALLOWED_MIME_TYPES.has(mimeType_temp)) {
            log(`Ignoring unsupported file type: ${mimeType_temp}`);
            return;
        }

        const result = await tablesDB.listRows(
            "printa4",
            "temp",
            [
                Query.equal("phone", message.from),
                Query.orderDesc("$updatedAt"),
                Query.limit(1)
            ]
        );

        const doc = result.rows?.[0];

        if (!doc) {
            return;
        }

        if (!media?.id) {
            return;
        }

        // Get media download URL
        const metaRes = await fetch(
            `https://graph.facebook.com/v23.0/${media.id}`,
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                },
            }
        );

        const metaData = await metaRes.json();

        if (!metaRes.ok) {
            return;
        }

        if (!metaData.url) {
            return;
        }

        // Download file
        const fileRes = await fetch(metaData.url, {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
            },
        });

        if (!fileRes.ok) {
            return;
        }

        const buffer = Buffer.from(
            await fileRes.arrayBuffer()
        );

        const mimeType =
            media.mime_type ||
            fileRes.headers.get("content-type") ||
            "application/octet-stream";

        const extension =
            mimeType.split("/")[1]?.split(";")[0] || "bin";

        const fileName =
            media.filename ||
            `${message.from}_${Date.now()}.${extension}`;

        const uploaded = await storage.createFile(
            doc.bucketID,
            "unique()",
            InputFile.fromBuffer(buffer, fileName)
        );

        log(
            `Uploaded file ${fileName} -> ${uploaded.$id}`
        );

        return uploaded;

    } catch (err) {
        error(err);
        return;
    }
}
