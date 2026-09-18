import { Client, TablesDB, Storage, Permission, Role } from 'node-appwrite';
import Razorpay from "razorpay";
import { updateJob } from "./db.js"

const APPWRITE_SERVER_ENDPOINT = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_SERVER_API_KEY = process.env.APPWRITE_SERVER_API_KEY;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_TRTbq1X3T3eMCZ";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "WvSE7bU2iGqGqUcMKmKebmWc";

/* -------------------- USER CREATE -------------------- */
const onCreateUser = async ({ req, res, storage, tablesDB }) => {
  const { $id: userId, name, email, phone } = req.body;

  const auth = Buffer.from(
    `${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`
  ).toString("base64");

  const response = await fetch("https://api.razorpay.com/v1/contacts", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: email.split("@")[0],
      email: email,
      reference_id: userId,
    }),
  });

  if (response.ok) {
    const contact = await response.json();
    const razorpay_id = contact.id;

    await tablesDB.createRow(
      'printa4',
      'users',
      userId,
      {
        email,
        phone,
        name,
        razorpay_id
      },
      [
        Permission.read(Role.user(userId)),
      ]
    );
  } else {
    await tablesDB.createRow(
      'printa4',
      'users',
      userId,
      {
        email,
        phone,
        name,
      },
      [
        Permission.read(Role.user(userId)),
      ]
    );
  }

  try {
    await storage.createBucket(
      userId,
      `user-${name}`,
      [
        Permission.read(Role.user(userId)),
        Permission.create(Role.user(userId)),
        Permission.read(Role.team("shop_owners")),
      ],
      true,
      true,
      undefined,
      ['pdf']
    );

    await tablesDB.createRow(
      'printa4',
      'users',
      userId,
      {
        email,
        phone,
        name,
      },
      [
        Permission.read(Role.user(userId)),
      ]
    );

  } catch {
    await tablesDB.createRow(
      'printa4',
      'users',
      userId,
      {
        email,
        phone,
        name,
      },
      [
        Permission.read(Role.user(userId)),
      ]
    );

    await storage.createBucket(
      userId,
      `user-${name}`,
      [
        Permission.read(Role.user(userId)),
        Permission.create(Role.user(userId)),
        Permission.read(Role.team("shop_owners")),
      ],
      true,
      true,
      undefined,
      ['pdf']
    );
  }

  return res.json({
    message: 'User bucket & document created',
    userId,
  });
};

/* -------------------- USER DELETE -------------------- */
const onDeleteUser = async ({ req, res, storage, log }) => {
  const { $id: userId } = req.body;

  try {
    await storage.deleteBucket(userId);
    log(`Bucket deleted for user ${userId}`);
  } catch {
    log(`Bucket not found for user ${userId}`);
  }

  return res.json({
    message: 'User cleanup completed',
    userId,
  });
};

/* -------------------- TEAM MEMBERSHIP CREATE -------------------- */
const onCreateTeamMembership = async ({ req, res, tablesDB, log, teamId }) => {
  log(req);

  const { userId } = req.body;

  // Only act for shop_owners team
  if (teamId !== 'shop_owners') {
    return res.json({ message: 'Non shop_owners team, ignored' });
  }

  try {
    await tablesDB.createRow(
      'printa4',
      'shopprotected',
      userId, // row ID = user ID
      {
        cftoken: "printa4"
      },
      [
        Permission.read(Role.user(userId)),
      ]
    );

    await tablesDB.createRow(
      'printa4',
      'shops',
      userId, // row ID = user ID
      {
        name: "",
        imageUrl: "",
        address: "",
        ownerName: "",
        autoCancelTimeOut: 120,
        phone: 9999999999,
      },
      [
        Permission.read(Role.user()),
        Permission.update(Role.user(userId)),
      ]
    );

    log(`Shop document created for user ${userId}`);
  } catch (err) {
    if (err.code === 409) {
      log(`Shop already exists for user ${userId}`);
    } else {
      throw err;
    }
  }

  try {
    await tablesDB.createRow(
      'printa4',
      'leds',
      userId, // row ID = user ID
      {
        left_start: 0,
        left_end: 0,
        right_start: 0,
        right_end: 0,
      },
      [
        Permission.read(Role.user()),
        Permission.update(Role.user(userId)),
      ]
    );

    log(`LED document created for user ${userId}`);
  } catch (err) {
    if (err.code === 409) {
      log(`LED document already exists for user ${userId}`);
    } else {
      throw err;
    }
  }

  return res.json({
    message: 'Shop owner processed',
    userId,
  });
};

const onDeleteTeamMembership = async ({
  req,
  res,
  tablesDB,
  log,
  teamId
}) => {
  const { userId } = req.body;

  // Only act for shop_owners team
  if (teamId !== 'shop_owners') {
    return res.json({ message: 'Non shop_owners team, ignored' });
  }

  try {
    await tablesDB.deleteRow(
      'printa4',
      'shops',
      userId
    );

    log(`Shop document deleted for user ${userId}`);
  } catch {
    log(`Shop document not found for user ${userId}`);
  }

  try {
    await tablesDB.deleteRow(
      'printa4',
      'leds',
      userId
    );

    log(`LED document deleted for user ${userId}`);
  } catch {
    log(`LED document not found for user ${userId}`);
  }

  return res.json({
    message: 'Shop owner membership removed',
    userId,
  });
};

/* -------------------- MAIN ROUTER -------------------- */
export default async ({ req, res, log, error }) => {
  if (req.method !== 'POST') {
    return res.send('Method not allowed', 403);
  }

  if (req.headers['x-appwrite-trigger'] !== 'event') {
    return res.send('Execution method not allowed', 403);
  }

  const event = req.headers['x-appwrite-event'];
  const parts = event.split('.');

  let handler = null;
  let teamId = null;

  // users.*.create
  if (event.startsWith('users.') && event.endsWith('.create')) {
    handler = onCreateUser;
  }

  // users.*.delete
  else if (event.startsWith('users.') && event.endsWith('.delete')) {
    handler = onDeleteUser;
  }

  // teams.{teamId}.memberships.{membershipId}.create
  else if (
    parts[0] === 'teams' &&
    parts[2] === 'memberships' &&
    parts[4] === 'create'
  ) {
    handler = onCreateTeamMembership;
    teamId = parts[1];
  }

  else if (
    parts[0] === 'teams' &&
    parts[2] === 'memberships' &&
    parts[4] === 'delete'
  ) {
    handler = onDeleteTeamMembership;
    teamId = parts[1];

    // Handle team membership deletion if needed
    return res.json({
      message: 'Team membership deletion not implemented'
    });
  }

  else if (
    parts[0] === 'databases'
  ) {
    handler = updateJob;
  }

  else {
    return res.send('Event not supported', 403);
  }

  const client = new Client()
    .setEndpoint(APPWRITE_SERVER_ENDPOINT) // http://appwrite/v1
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_SERVER_API_KEY);

  const storage = new Storage(client);
  const tablesDB = new TablesDB(client);

  return handler({
    req,
    res,
    log,
    error,
    client,
    storage,
    tablesDB,
    teamId,
  });
};