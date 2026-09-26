import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function Root() {
  const { userId } = await auth();
  redirect(userId ? "/home" : "/login");
}
