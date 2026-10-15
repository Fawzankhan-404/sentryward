import { prisma } from "../prisma.ts";

export const PAGE_SIZE = 25;

// `page` is 1-based, as the API documents and the client sends it.
export async function listOrders(customerId: string, page = 1) {
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.order.count({ where: { customerId } }),
  ]);
  return { orders, page, pages: Math.ceil(total / PAGE_SIZE) };
}
