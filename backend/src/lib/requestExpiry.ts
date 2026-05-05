import prisma from './prisma';

const REQUEST_EXPIRY_MS = 2 * 60 * 60 * 1000;
const EXPIRABLE_REQUEST_STATUSES = ['OPEN', 'NEGOTIATING'] as const;
const ACTIVE_QUOTE_STATUSES = ['PENDING', 'COUNTERED'] as const;

export async function expireStaleRequests(): Promise<void> {
  const cutoff = new Date(Date.now() - REQUEST_EXPIRY_MS);

  const candidates = await prisma.request.findMany({
    where: {
      status: { in: [...EXPIRABLE_REQUEST_STATUSES] },
      createdAt: { lt: cutoff },
    },
    include: {
      quotes: {
        where: { status: { in: [...ACTIVE_QUOTE_STATUSES] } },
        select: { id: true, updatedAt: true },
      },
    },
  });

  if (!candidates.length) return;

  const expiredRequestIds = candidates
    .filter((request) => {
      if (!request.quotes.length) {
        return request.createdAt <= cutoff;
      }

      const latestQuoteActivity = request.quotes.reduce(
        (latest, quote) => (quote.updatedAt > latest ? quote.updatedAt : latest),
        request.updatedAt,
      );

      return latestQuoteActivity <= cutoff;
    })
    .map((request) => request.id);

  if (!expiredRequestIds.length) return;

  await prisma.request.updateMany({
    where: { id: { in: expiredRequestIds } },
    data: { status: 'EXPIRED' },
  });

  await prisma.quote.updateMany({
    where: {
      requestId: { in: expiredRequestIds },
      status: { in: [...ACTIVE_QUOTE_STATUSES] },
    },
    data: { status: 'REJECTED' },
  });
}
