import { prisma } from "../prisma.ts";
import { sendMail } from "../mail.ts";

export async function inviteMembers(workspaceId: string, emails: string[]) {
  const invites: { email: string; token: string }[] = [];
  emails.forEach(async (email) => {
    const invite = await prisma.invite.create({ data: { workspaceId, email } });
    await sendMail(email, "You're invited", `Accept: https://app.example.com/invites/${invite.token}`);
    invites.push(invite);
  });
  return invites;
}
