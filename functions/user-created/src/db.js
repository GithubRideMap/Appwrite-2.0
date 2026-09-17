import { Permission, Role } from "node-appwrite";

export const updateJob = async ({
  req,
  res,
  log,
  error,
  client,
  storage,
  tablesDB
}) => {
  const {
    org_id,
    print_completed,
    estimated_cost,
    isCredited,
    $id,
    user_id,
    file_id
  } = req.body;

  if (print_completed || !isCredited) {
    const userDoc = await tablesDB.getRow(
      "printa4",
      "users",
      org_id
    );

    const newBalance = +(estimated_cost * 0.97).toFixed(2);

    await tablesDB.updateRow(
      "printa4",
      "users",
      org_id,
      {
        wallet_balance: newBalance
      }
    );

    await tablesDB.updateRow(
      "printa4",
      "jobs",
      $id,
      {
        isCredited: true
      },
      [
        Permission.read(Role.user(user_id)),
        Permission.read(Role.user(org_id)),
      ]
    );

    await storage.updateFile({
      bucketId: user_id,
      fileId: file_id,
      permissions: [
      ],
    });
  }

  return res.json({ "status": "done" }, 200);
};