import { redirect } from "next/navigation";

/** One flow for everyone: the phone login signs new numbers up automatically. */
export default function SignupPage() {
  redirect("/login");
}
