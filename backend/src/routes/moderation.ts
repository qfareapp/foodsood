import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import {
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  areUsersBlocked,
} from '../lib/moderation';
import { AuthRequest, requireAuth } from '../middleware/auth';

const router = Router();

const reportSchema = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.string().min(1).max(120),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(500).optional(),
});

async function resolveReportTarget(
  targetType: (typeof REPORT_TARGET_TYPES)[number],
  targetId: string,
): Promise<{ targetUserId?: string | null }> {
  if (targetType === 'USER') {
    const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!user) throw new Error('Target user not found');
    return { targetUserId: user.id };
  }

  if (targetType === 'REVIEW') {
    const review = await prisma.review.findUnique({
      where: { id: targetId },
      select: { id: true, reviewerId: true, chefId: true },
    });
    if (!review) throw new Error('Target review not found');
    return { targetUserId: review.reviewerId || review.chefId };
  }

  if (targetType === 'PROFILE') {
    const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!user) throw new Error('Target profile not found');
    return { targetUserId: user.id };
  }

  if (targetType === 'KITCHEN_IMAGE') {
    const [userId] = targetId.split(':');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, kitchenImages: true },
    });
    if (!user) throw new Error('Target image owner not found');
    return { targetUserId: user.id };
  }

  throw new Error('Unsupported report target');
}

router.get('/reasons', requireAuth, (_req, res) => {
  res.json({
    reasons: REPORT_REASONS,
    targetTypes: REPORT_TARGET_TYPES,
    statuses: REPORT_STATUSES,
  });
});

router.post('/accept-ugc-policy', requireAuth, async (req: AuthRequest, res) => {
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { ugcPolicyAcceptedAt: new Date() },
    select: { ugcPolicyAcceptedAt: true },
  });
  res.json({ success: true });
});

router.get('/blocks', requireAuth, async (req: AuthRequest, res) => {
  const blocks = await prisma.userBlock.findMany({
    where: { blockerId: req.user!.userId },
    orderBy: { createdAt: 'desc' },
    include: {
      blockedUser: {
        select: { id: true, name: true, role: true, city: true, avatar: true },
      },
    },
  });
  res.json(blocks.map((block) => ({
    id: block.id,
    createdAt: block.createdAt,
    user: block.blockedUser,
  })));
});

router.post('/block/:userId', requireAuth, async (req: AuthRequest, res) => {
  const targetUserId = String(req.params.userId);
  if (!targetUserId) {
    res.status(400).json({ error: 'User id required' });
    return;
  }
  if (targetUserId === req.user!.userId) {
    res.status(400).json({ error: 'You cannot block yourself' });
    return;
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true },
  });
  if (!targetUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const block = await prisma.userBlock.upsert({
    where: {
      blockerId_blockedUserId: {
        blockerId: req.user!.userId,
        blockedUserId: targetUserId,
      },
    },
    create: { blockerId: req.user!.userId, blockedUserId: targetUserId },
    update: {},
  });

  res.status(201).json({ success: true, block });
});

router.delete('/block/:userId', requireAuth, async (req: AuthRequest, res) => {
  const targetUserId = String(req.params.userId);
  await prisma.userBlock.deleteMany({
    where: {
      blockerId: req.user!.userId,
      blockedUserId: targetUserId,
    },
  });
  res.json({ success: true });
});

router.post('/reports', requireAuth, async (req: AuthRequest, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  let targetUserId: string | null | undefined;
  try {
    ({ targetUserId } = await resolveReportTarget(parsed.data.targetType, parsed.data.targetId));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Report target not found' });
    return;
  }

  const duplicate = await prisma.contentReport.findFirst({
    where: {
      reporterId: req.user!.userId,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      status: { in: ['OPEN', 'REVIEWING'] },
    },
    select: { id: true },
  });
  if (duplicate) {
    res.status(409).json({ error: 'You already have an open report for this item' });
    return;
  }

  const report = await prisma.contentReport.create({
    data: {
      reporterId: req.user!.userId,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      targetUserId: targetUserId ?? null,
      reason: parsed.data.reason,
      details: parsed.data.details?.trim() || null,
    },
  });

  res.status(201).json(report);
});

router.get('/relation/:userId', requireAuth, async (req: AuthRequest, res) => {
  const otherUserId = String(req.params.userId);
  const blocked = await areUsersBlocked(req.user!.userId, otherUserId);
  const blockedByMe = await prisma.userBlock.findFirst({
    where: { blockerId: req.user!.userId, blockedUserId: otherUserId },
    select: { id: true },
  });
  res.json({
    blocked,
    blockedByMe: Boolean(blockedByMe),
  });
});

export default router;
