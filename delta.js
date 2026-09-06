
require("dotenv").config();

const sdk = require("node-appwrite");

const client = new sdk.Client()
    .setEndpoint("https://app.printa4.in/v1")
    .setProject("printa4")
    .setKey("standard_9997118173a43e975da6218a16aad732d77671de1e4e8bc322ec54bb9532b2db31fdf4de0e7aa33b7d4c9e5c595c3cf2ca94f3e3aae2c8645285756946ac5eeb0bf5d65b20955107356fe5e74cac0ef3236a0ba14d4d82069ec06fa86c51821263f31ef04bb8d4354df3af15180f4568d84f0b9ffee1782661c220441b67458c");


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
