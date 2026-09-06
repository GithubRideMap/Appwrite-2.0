
require("dotenv").config();

const sdk = require("node-appwrite");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const DRY_RUN = process.env.DRY_RUN === "true";

const SOURCE = {
    endpoint: process.env.SOURCE_ENDPOINT,
    projectId: process.env.SOURCE_PROJECT_ID,
    apiKey: process.env.SOURCE_API_KEY,
};

const DEST = {
    endpoint: process.env.DEST_ENDPOINT,
    projectId: process.env.DEST_PROJECT_ID,
    apiKey: process.env.DEST_API_KEY,
};

// ============================================================
// VALIDATION
// ============================================================

function validateConfig() {
    const required = [
        ["SOURCE_ENDPOINT", SOURCE.endpoint],
        ["SOURCE_PROJECT_ID", SOURCE.projectId],
        ["SOURCE_API_KEY", SOURCE.apiKey],

        ["DEST_ENDPOINT", DEST.endpoint],
        ["DEST_PROJECT_ID", DEST.projectId],
        ["DEST_API_KEY", DEST.apiKey],
    ];

    const missing = required
        .filter(([, value]) => !value)
        .map(([name]) => name);

    if (missing.length) {
        throw new Error(
            `Missing environment variables:\n${missing.join("\n")}`
        );
    }
}

// ============================================================
// CLIENTS
// ============================================================

function createClient(config) {
    return new sdk.Client()
        .setEndpoint(config.endpoint)
        .setProject(config.projectId)
        .setKey(config.apiKey);
}

const sourceClient = createClient(SOURCE);
const destClient = createClient(DEST);

const sourceUsers = new sdk.Users(sourceClient);
const destUsers = new sdk.Users(destClient);

const sourceTeams = new sdk.Teams(sourceClient);
const destTeams = new sdk.Teams(destClient);

// ============================================================
// OUTPUT
// ============================================================

const OUTPUT_DIR = path.join(process.cwd(), "migration-output");

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const report = {
    startedAt: new Date().toISOString(),

    users: {
        total: 0,
        created: 0,
        existing: 0,
        updated: 0,
        failed: 0,
    },

    teams: {
        total: 0,
        created: 0,
        existing: 0,
        updated: 0,
        failed: 0,
    },

    memberships: {
        total: 0,
        created: 0,
        existing: 0,
        failed: 0,
    },

    errors: [],
};

const userIdMap = new Map();
const teamIdMap = new Map();

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
    return (
        error?.message ||
        error?.response?.message ||
        String(error)
    );
}

function isNotFound(error) {
    return (
        error?.code === 404 ||
        error?.response?.code === 404
    );
}

function isConflict(error) {
    return (
        error?.code === 409 ||
        error?.response?.code === 409
    );
}

function logError(type, id, error) {
    const message = errorMessage(error);

    console.error(
        `[ERROR] ${type} ${id}: ${message}`
    );

    report.errors.push({
        type,
        id,
        error: message,
    });
}

// ============================================================
// GENERIC PAGINATION
// ============================================================

async function listAllUsers() {
    const result = [];

    let offset = 0;

    while (true) {
        console.log(
            `SOURCE USERS: offset=${offset}`
        );

        const response = await sourceUsers.list({
            queries: [
                sdk.Query.limit(PAGE_SIZE),
                sdk.Query.offset(offset),
            ],
        });

        result.push(...response.users);

        if (response.users.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;
    }

    return result;
}

async function listAllTeams() {
    const result = [];

    let offset = 0;

    while (true) {
        console.log(
            `SOURCE TEAMS: offset=${offset}`
        );

        const response = await sourceTeams.list({
            queries: [
                sdk.Query.limit(PAGE_SIZE),
                sdk.Query.offset(offset),
            ],
        });

        result.push(...response.teams);

        if (response.teams.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;
    }

    return result;
}

async function listAllMemberships(teamId) {
    const result = [];

    let offset = 0;

    while (true) {
        const response = await sourceTeams.listMemberships({
            teamId,
            queries: [
                sdk.Query.limit(PAGE_SIZE),
                sdk.Query.offset(offset),
            ],
        });

        result.push(...response.memberships);

        if (response.memberships.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;
    }

    return result;
}

// ============================================================
// USER MIGRATION
// ============================================================

async function migrateUsers() {
    console.log("");
    console.log("============================================");
    console.log("MIGRATING USERS");
    console.log("============================================");

    const users = await listAllUsers();

    report.users.total = users.length;

    console.log(
        `Found ${users.length} source users`
    );

    for (const user of users) {
        const userId = user.$id;

        try {
            console.log(
                `[USER] ${userId} | ${user.email || user.phone || user.name || ""}`
            );

            // ------------------------------------------------
            // Check destination
            // ------------------------------------------------

            let destinationUser = null;

            try {
                destinationUser = await destUsers.get({
                    userId,
                });
            } catch (error) {
                if (!isNotFound(error)) {
                    throw error;
                }
            }

            // ------------------------------------------------
            // CREATE
            // ------------------------------------------------

            if (!destinationUser) {
                if (DRY_RUN) {
                    console.log(
                        `[DRY RUN] Would create user ${userId}`
                    );

                    userIdMap.set(userId, userId);
                    continue;
                }

                destinationUser = await destUsers.create({
                    userId: user.$id,

                    email: user.email || undefined,

                    phone: user.phone || undefined,

                    name: user.name || undefined,
                });

                report.users.created++;

                console.log(
                    `[CREATED] User ${userId}`
                );
            } else {
                report.users.existing++;

                console.log(
                    `[EXISTS] User ${userId}`
                );
            }

            userIdMap.set(
                user.$id,
                destinationUser.$id
            );

            // ------------------------------------------------
            // UPDATE STATUS
            // ------------------------------------------------

            if (!DRY_RUN) {
                try {
                    await destUsers.updateStatus({
                        userId,
                        status: user.status,
                    });

                    report.users.updated++;
                } catch (error) {
                    console.warn(
                        `[WARN] Could not update status for ${userId}:`,
                        errorMessage(error)
                    );
                }
            }

            // ------------------------------------------------
            // EMAIL VERIFICATION
            // ------------------------------------------------

            if (!DRY_RUN && user.emailVerification) {
                try {
                    await destUsers.updateEmailVerification({
                        userId,
                        emailVerification: true,
                    });
                } catch (error) {
                    console.warn(
                        `[WARN] Email verification failed for ${userId}:`,
                        errorMessage(error)
                    );
                }
            }

            // ------------------------------------------------
            // PHONE VERIFICATION
            // ------------------------------------------------

            if (!DRY_RUN && user.phoneVerification) {
                try {
                    await destUsers.updatePhoneVerification({
                        userId,
                        phoneVerification: true,
                    });
                } catch (error) {
                    console.warn(
                        `[WARN] Phone verification failed for ${userId}:`,
                        errorMessage(error)
                    );
                }
            }

            // ------------------------------------------------
            // LABELS
            // ------------------------------------------------

            if (!DRY_RUN && Array.isArray(user.labels)) {
                try {
                    await destUsers.updateLabels({
                        userId,
                        labels: user.labels,
                    });
                } catch (error) {
                    console.warn(
                        `[WARN] Labels failed for ${userId}:`,
                        errorMessage(error)
                    );
                }
            }

            // ------------------------------------------------
            // PREFERENCES
            // ------------------------------------------------

            if (!DRY_RUN) {
                try {
                    const prefs = await sourceUsers.getPrefs({
                        userId,
                    });

                    await destUsers.updatePrefs({
                        userId,
                        prefs: prefs,
                    });
                } catch (error) {
                    console.warn(
                        `[WARN] Preferences failed for ${userId}:`,
                        errorMessage(error)
                    );
                }
            }

            await sleep(10);

        } catch (error) {
            report.users.failed++;

            logError(
                "USER",
                userId,
                error
            );
        }
    }
}

// ============================================================
// TEAM MIGRATION
// ============================================================

async function migrateTeams() {
    console.log("");
    console.log("============================================");
    console.log("MIGRATING TEAMS");
    console.log("============================================");

    const teams = await listAllTeams();

    report.teams.total = teams.length;

    console.log(
        `Found ${teams.length} source teams`
    );

    for (const team of teams) {
        const teamId = team.$id;

        try {
            console.log(
                `[TEAM] ${teamId} | ${team.name}`
            );

            // ------------------------------------------------
            // Check destination
            // ------------------------------------------------

            let destinationTeam = null;

            try {
                destinationTeam = await destTeams.get({
                    teamId,
                });
            } catch (error) {
                if (!isNotFound(error)) {
                    throw error;
                }
            }

            // ------------------------------------------------
            // CREATE TEAM
            // ------------------------------------------------

            if (!destinationTeam) {
                if (DRY_RUN) {
                    console.log(
                        `[DRY RUN] Would create team ${teamId}`
                    );

                    teamIdMap.set(
                        teamId,
                        teamId
                    );

                    continue;
                }

                destinationTeam = await destTeams.create({
                    teamId: team.$id,
                    name: team.name,
                    roles: [],
                });

                report.teams.created++;

                console.log(
                    `[CREATED] Team ${teamId}`
                );
            } else {
                report.teams.existing++;

                console.log(
                    `[EXISTS] Team ${teamId}`
                );
            }

            teamIdMap.set(
                team.$id,
                destinationTeam.$id
            );

            // ------------------------------------------------
            // TEAM PREFERENCES
            // ------------------------------------------------

            if (!DRY_RUN) {
                try {
                    const prefs =
                        await sourceTeams.getPrefs({
                            teamId,
                        });

                    await destTeams.updatePrefs({
                        teamId,
                        prefs: prefs,
                    });

                    report.teams.updated++;
                } catch (error) {
                    console.warn(
                        `[WARN] Team prefs failed for ${teamId}:`,
                        errorMessage(error)
                    );
                }
            }

            await sleep(10);

        } catch (error) {
            report.teams.failed++;

            logError(
                "TEAM",
                teamId,
                error
            );
        }
    }
}

// ============================================================
// MEMBERSHIP MIGRATION
// ============================================================

async function migrateMemberships() {
    console.log("");
    console.log("============================================");
    console.log("MIGRATING TEAM MEMBERSHIPS");
    console.log("============================================");

    const teams = await listAllTeams();

    for (const sourceTeam of teams) {
        const sourceTeamId = sourceTeam.$id;

        const destinationTeamId =
            teamIdMap.get(sourceTeamId);

        if (!destinationTeamId) {
            console.warn(
                `[SKIP] No destination team mapping for ${sourceTeamId}`
            );

            continue;
        }

        console.log("");
        console.log(
            `TEAM MEMBERSHIPS: ${sourceTeam.name} (${sourceTeamId})`
        );

        let memberships;

        try {
            memberships =
                await listAllMemberships(
                    sourceTeamId
                );
        } catch (error) {
            logError(
                "MEMBERSHIPS",
                sourceTeamId,
                error
            );

            continue;
        }

        console.log(
            `Found ${memberships.length} memberships`
        );

        for (const membership of memberships) {
            report.memberships.total++;

            const sourceUserId =
                membership.userId;

            const destinationUserId =
                userIdMap.get(sourceUserId);

            if (!destinationUserId) {
                report.memberships.failed++;

                logError(
                    "MEMBERSHIP",
                    membership.$id,
                    new Error(
                        `No destination user mapping for ${sourceUserId}`
                    )
                );

                continue;
            }

            try {
                console.log(
                    `[MEMBERSHIP] ${sourceUserId} -> ${sourceTeamId} | roles=${JSON.stringify(membership.roles)}`
                );

                if (DRY_RUN) {
                    console.log(
                        `[DRY RUN] Would create membership`
                    );

                    continue;
                }

                // ------------------------------------------------
                // Check if membership already exists
                // ------------------------------------------------

                let existingMembership = null;

                try {
                    const existing =
                        await destTeams.listMemberships({
                            teamId: destinationTeamId,

                            queries: [
                                sdk.Query.equal(
                                    "userId",
                                    destinationUserId
                                ),

                                sdk.Query.limit(1),
                            ],
                        });

                    if (
                        existing.memberships &&
                        existing.memberships.length
                    ) {
                        existingMembership =
                            existing.memberships[0];
                    }
                } catch (error) {
                    // If listing fails, continue to creation.
                    console.warn(
                        `[WARN] Could not check membership:`,
                        errorMessage(error)
                    );
                }

                // ------------------------------------------------
                // Already exists
                // ------------------------------------------------

                if (existingMembership) {
                    console.log(
                        `[EXISTS] Membership ${sourceUserId} -> ${sourceTeamId}`
                    );

                    // Update roles if possible
                    try {
                        await destTeams.updateMembership({
                            teamId: destinationTeamId,

                            membershipId:
                                existingMembership.$id,

                            roles:
                                membership.roles || [],
                        });
                    } catch (error) {
                        console.warn(
                            `[WARN] Could not update roles:`,
                            errorMessage(error)
                        );
                    }

                    report.memberships.existing =
                        (report.memberships.existing || 0) + 1;

                    continue;
                }

                // ------------------------------------------------
                // CREATE MEMBERSHIP
                // ------------------------------------------------

                await destTeams.createMembership({
                    teamId: destinationTeamId,

                    userId: destinationUserId,

                    roles: membership.roles || [],

                    name:
                        membership.userName ||
                        undefined,
                });

                report.memberships.created++;

                console.log(
                    `[CREATED] Membership ${sourceUserId} -> ${sourceTeamId}`
                );

                await sleep(10);

            } catch (error) {
                report.memberships.failed++;

                logError(
                    "MEMBERSHIP",
                    membership.$id,
                    error
                );
            }
        }
    }
}

// ============================================================
// WRITE REPORT
// ============================================================

function writeReport() {
    report.finishedAt =
        new Date().toISOString();

    const reportFile =
        path.join(
            OUTPUT_DIR,
            "migration-report.json"
        );

    fs.writeFileSync(
        reportFile,
        JSON.stringify(
            report,
            null,
            2
        )
    );

    console.log("");
    console.log(
        `Report written to: ${reportFile}`
    );
}

// ============================================================
// SUMMARY
// ============================================================

function printSummary() {
    console.log("");
    console.log("");
    console.log("==================================================");
    console.log("                 MIGRATION SUMMARY");
    console.log("==================================================");

    console.log("");

    console.log("USERS");
    console.log(
        `  Total     : ${report.users.total}`
    );
    console.log(
        `  Created   : ${report.users.created}`
    );
    console.log(
        `  Existing  : ${report.users.existing}`
    );
    console.log(
        `  Updated   : ${report.users.updated}`
    );
    console.log(
        `  Failed    : ${report.users.failed}`
    );

    console.log("");

    console.log("TEAMS");
    console.log(
        `  Total     : ${report.teams.total}`
    );
    console.log(
        `  Created   : ${report.teams.created}`
    );
    console.log(
        `  Existing  : ${report.teams.existing}`
    );
    console.log(
        `  Updated   : ${report.teams.updated}`
    );
    console.log(
        `  Failed    : ${report.teams.failed}`
    );

    console.log("");

    console.log("MEMBERSHIPS");
    console.log(
        `  Total     : ${report.memberships.total}`
    );
    console.log(
        `  Created   : ${report.memberships.created}`
    );
    console.log(
        `  Existing  : ${report.memberships.existing || 0}`
    );
    console.log(
        `  Failed    : ${report.memberships.failed}`
    );

    console.log("");

    console.log(
        `Errors     : ${report.errors.length}`
    );

    console.log("");

    console.log("==================================================");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    try {
        validateConfig();

        console.log("");
        console.log("==================================================");
        console.log("       APPWRITE AUTH MIGRATION");
        console.log("==================================================");

        console.log("");
        console.log(
            `Source      : ${SOURCE.endpoint}`
        );

        console.log(
            `Destination : ${DEST.endpoint}`
        );

        console.log(
            `Dry Run     : ${DRY_RUN}`
        );

        console.log("");

        if (DRY_RUN) {
            console.log(
                "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
            );

            console.log(
                "DRY RUN ENABLED - NO DATA WILL BE MODIFIED"
            );

            console.log(
                "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
            );
        }

        // ----------------------------------------------------
        // IMPORTANT ORDER
        // ----------------------------------------------------

        // 1. Users
        await migrateUsers();

        // 2. Teams
        await migrateTeams();

        // 3. Memberships
        await migrateMemberships();

        // 4. Report
        writeReport();

        // 5. Summary
        printSummary();

    } catch (error) {
        console.error("");
        console.error(
            "FATAL MIGRATION ERROR:"
        );

        console.error(error);

        writeReport();

        process.exit(1);
    }
}

main();
