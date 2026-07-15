import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import prisma from './prisma';

const ACTIVE_ORDER_STATUSES = ['CONFIRMED', 'COOKING', 'READY', 'OUT_FOR_DELIVERY'];
const ACTIVE_DIRECT_OFFER_STATUSES = ['HOLD', 'ADVANCE_PAID', 'PAID'];
const OPEN_REQUEST_STATUSES = ['OPEN', 'NEGOTIATING', 'PAYMENT_PENDING'];
const NEGOTIABLE_QUOTE_STATUSES = ['PENDING', 'COUNTERED'];

function deletedPhoneValue(): string {
  return `9${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
}

function deletedEmailValue(userId: string): string {
  return `deleted-${userId}@deleted.foodsood.local`;
}

export async function getDeletionReviewNeeds(userId: string) {
  const [
    activeBuyerOrders,
    activeChefOrders,
    activeDirectOffers,
  ] = await Promise.all([
    prisma.order.count({
      where: { buyerId: userId, status: { in: ACTIVE_ORDER_STATUSES } },
    }),
    prisma.order.count({
      where: { chefId: userId, status: { in: ACTIVE_ORDER_STATUSES } },
    }),
    prisma.dishOffer.count({
      where: { chefId: userId, status: { in: ACTIVE_DIRECT_OFFER_STATUSES } },
    }),
  ]);

  return {
    needsReview: activeBuyerOrders > 0 || activeChefOrders > 0 || activeDirectOffers > 0,
    activeBuyerOrders,
    activeChefOrders,
    activeDirectOffers,
  };
}

export async function applyAccountDeletion(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      name: true,
      email: true,
      phone: true,
      deletedAt: true,
    },
  });

  if (!user) {
    throw new Error('User not found');
  }
  if (user.deletedAt) {
    return { alreadyDeleted: true };
  }

  const hashedPassword = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  const now = new Date();
  const deletedName = user.role === 'CHEF' ? 'Deleted Chef' : 'Deleted User';

  if (user.email) {
    await prisma.emailOtp.deleteMany({ where: { email: user.email } });
  }

  await prisma.address.deleteMany({ where: { userId } });
  await prisma.savedChef.deleteMany({
    where: {
      OR: [{ savedById: userId }, { chefId: userId }],
    },
  });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.fcmToken.deleteMany({ where: { userId } });
  await prisma.userBlock.deleteMany({
    where: {
      OR: [{ blockerId: userId }, { blockedUserId: userId }],
    },
  });
  await prisma.marketPriceEntry.deleteMany({ where: { chefId: userId } });
  await prisma.chefDish.deleteMany({ where: { chefId: userId } });

  await prisma.request.updateMany({
    where: { userId },
    data: {
      notes: null,
      city: null,
      lat: null,
      lng: null,
      targetChefId: null,
    },
  });
  await prisma.request.updateMany({
    where: {
      userId,
      status: { in: OPEN_REQUEST_STATUSES },
    },
    data: {
      status: 'CANCELLED',
    },
  });

  await prisma.quote.updateMany({
    where: {
      chefId: userId,
      status: { in: NEGOTIABLE_QUOTE_STATUSES },
    },
    data: { status: 'WITHDRAWN' },
  });

  await prisma.order.updateMany({
    where: { buyerId: userId },
    data: { address: null },
  });

  await prisma.review.updateMany({
    where: { reviewerId: userId },
    data: { comment: null },
  });
  await prisma.review.updateMany({
    where: { chefId: userId },
    data: { comment: null, isHidden: true },
  });

  await prisma.dishOffer.updateMany({
    where: {
      chefId: userId,
      status: { in: ['PENDING', 'COUNTERED', 'HOLD'] },
    },
    data: {
      status: 'REJECTED',
      counterNote: null,
      message: null,
      holdUntil: null,
    },
  });
  await prisma.dishOffer.updateMany({
    where: { chefId: userId },
    data: {
      reviewComment: null,
    },
  });

  await prisma.contentReport.updateMany({
    where: { targetUserId: userId },
    data: { targetUserId: null },
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      name: deletedName,
      phone: deletedPhoneValue(),
      email: deletedEmailValue(userId),
      password: hashedPassword,
      avatar: null,
      coverImage: null,
      bio: null,
      cookingStyle: null,
      location: null,
      city: null,
      lat: null,
      lng: null,
      isActive: false,
      deletedAt: now,
      ugcPolicyAcceptedAt: null,
      kitchenImages: null,
      specialityDishes: null,
      rating: 0,
      ratingCount: 0,
      totalOrders: 0,
    },
  });

  await prisma.accountDeletionRequest.updateMany({
    where: {
      userId,
      status: { in: ['PENDING', 'IN_REVIEW'] },
    },
    data: {
      status: 'COMPLETED',
      processedAt: now,
    },
  });

  return { alreadyDeleted: false };
}
