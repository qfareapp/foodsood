import prisma from './prisma';

export const REPORT_REASONS = [
  'HARASSMENT',
  'HATE',
  'SEXUAL',
  'SPAM',
  'IMPERSONATION',
  'SCAM',
  'VIOLENCE',
  'OTHER',
] as const;

export const REPORT_TARGET_TYPES = [
  'USER',
  'REVIEW',
  'PROFILE',
  'KITCHEN_IMAGE',
] as const;

export const REPORT_STATUSES = ['OPEN', 'REVIEWING', 'RESOLVED', 'REJECTED'] as const;

export async function areUsersBlocked(userAId: string, userBId: string): Promise<boolean> {
  const match = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: userAId, blockedUserId: userBId },
        { blockerId: userBId, blockedUserId: userAId },
      ],
    },
    select: { id: true },
  });
  return Boolean(match);
}

export async function getBlockedUserIds(userId: string): Promise<string[]> {
  const rows = await prisma.userBlock.findMany({
    where: { blockerId: userId },
    select: { blockedUserId: true },
  });
  return rows.map((row) => row.blockedUserId);
}

export async function assertNotBlocked(userAId: string, userBId: string): Promise<void> {
  if (await areUsersBlocked(userAId, userBId)) {
    throw new Error('This user interaction is unavailable because one side has blocked the other.');
  }
}
