import { prisma } from "../prisma.ts";

export async function listOrders(customerId: string) {
  return prisma.order.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
  });
}
