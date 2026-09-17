
require("dotenv").config();

const sdk = require("node-appwrite");

const client = new sdk.Client()
    .setEndpoint("https://app.printa4.in/v1")
    .setProject("printa4")
    .setKey("standard_b9b68539d6e2d4e90da09e18739c79fb2f9e80a0cc851e9eb3ce25ee84a1bd0703e453d27eac3d4966f22d8ee24e8418596744b55ac8686e29a6ec1c23ac2510ef123e49598c167c0a4d2645e4ba587b7fe4450cdd6a63359368264a46a5246db0c55d5000e08757c98751c4e012df39e6f1ba1d311c931a70e5ff6bb0ba7a7b");


const databases = new sdk.Databases(client);

const DATABASE_ID = "printa4"
const COLLECTION_ID = "users"

const PAGE_SIZE = 100;

async function updateAllDocuments() {
    let offset = 0;

    let total = 0;
    let updated = 0;
    let failed = 0;

    while (true) {
        console.log(`Fetching documents: offset=${offset}`);

        const response = await databases.listDocuments(
            DATABASE_ID,
            COLLECTION_ID,
            [
                sdk.Query.limit(PAGE_SIZE),
                sdk.Query.offset(offset),
            ]
        );

        const documents = response.documents;

        if (documents.length === 0) {
            break;
        }

        total += documents.length;

        for (const document of documents) {
            try {
                await databases.updateDocument(
                    DATABASE_ID,
                    COLLECTION_ID,
                    document.$id,
                    {
                        isValidated: false,
                    }
                );

                updated++;

                console.log(
                    `[${updated}] ${document.$id} → isValidated=false`
                );

            } catch (error) {
                failed++;

                console.error(
                    `[FAILED] ${document.$id}:`,
                    error.message
                );
            }
        }

        if (documents.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;
    }

    console.log("");
    console.log("======================================");
    console.log("UPDATE COMPLETED");
    console.log("======================================");
    console.log(`Total documents : ${total}`);
    console.log(`Updated         : ${updated}`);
    console.log(`Failed          : ${failed}`);
}

updateAllDocuments()
    .catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
