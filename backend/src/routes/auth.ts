import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { signAccess, signRefresh, verifyRefresh } from '../lib/jwt';
import { sendOtpEmail } from '../lib/email';
import prisma from '../lib/prisma';

const router = Router();

const REFRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generatedBuyerEmail(phone: string): string {
  return `buyer-${createHash('sha256').update(`email:${phone}`).digest('hex').slice(0, 20)}@buyer.local`;
}

const registerSchema = z.object({
  name: z.string().min(2).max(80),
  phone: z.string().min(10).max(15),
  email: z.string().email().optional(),
  password: z.string().min(6),
  role: z.enum(['BUYER', 'CHEF', 'BOTH']).default('BUYER'),
  city: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

const loginSchema = z.object({
  phone: z.string(),
  password: z.string(),
});

// ── POST /api/auth/register ─────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { name, phone, email, password, role, city, lat, lng } = parsed.data;
  const normalizedEmail = email?.trim().toLowerCase() || generatedBuyerEmail(phone);

  const conflict = await prisma.user.findFirst({
    where: { OR: [{ phone }, ...(email ? [{ email: normalizedEmail }] : [])] },
    select: { id: true },
  });
  if (conflict) {
    res.status(409).json({ error: 'Phone or email already registered' });
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, phone, email: normalizedEmail, password: hashed, role, city, lat, lng },
    select: { id: true, name: true, phone: true, email: true, role: true, city: true, createdAt: true },
  });

  const accessToken = signAccess(user.id, user.role);
  const refreshToken = signRefresh(user.id);
  await prisma.refreshToken.create({
    data: { userId: user.id, token: refreshToken, expiresAt: new Date(Date.now() + REFRESH_MS) },
  });

  res.status(201).json({ user, accessToken, refreshToken });
});

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { phone, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(401).json({ error: 'Invalid phone number or password' });
    return;
  }

  if (!user.isActive) {
    res.status(403).json({ error: 'Account deactivated' });
    return;
  }

  const accessToken = signAccess(user.id, user.role);
  const refreshToken = signRefresh(user.id);
  await prisma.refreshToken.create({
    data: { userId: user.id, token: refreshToken, expiresAt: new Date(Date.now() + REFRESH_MS) },
  });

  const { password: _pw, ...safeUser } = user;
  res.json({ user: safeUser, accessToken, refreshToken });
});

// ── POST /api/auth/refresh ──────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken required' });
    return;
  }

  let payload: { userId: string };
  try {
    payload = verifyRefresh(refreshToken);
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }

  const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
  if (!stored || stored.expiresAt < new Date()) {
    res.status(401).json({ error: 'Refresh token expired or revoked' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, role: true, isActive: true },
  });
  if (!user || !user.isActive) {
    res.status(401).json({ error: 'User not found or deactivated' });
    return;
  }

  // Rotate: tolerate duplicate refresh/logout races by deleting if present.
  await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
  const newRefreshToken = signRefresh(user.id);
  await prisma.refreshToken.create({
    data: { userId: user.id, token: newRefreshToken, expiresAt: new Date(Date.now() + REFRESH_MS) },
  });

  res.json({ accessToken: signAccess(user.id, user.role), refreshToken: newRefreshToken });
});

// ── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
  }
  res.json({ success: true });
});

// ── POST /api/auth/send-otp ─────────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email required' });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // Invalidate old OTPs for this email
  await prisma.emailOtp.updateMany({
    where: { email, used: false },
    data: { used: true },
  });

  await prisma.emailOtp.create({ data: { email, otp, expiresAt } });

  try {
    await sendOtpEmail(email, otp);
  } catch (err) {
    console.error('Failed to send OTP email:', err);
    res.status(502).json({ error: 'Failed to send verification email. Please try again.' });
    return;
  }

  res.json({ sent: true });
});

// ── POST /api/auth/verify-otp ───────────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  const schema = z.object({ email: z.string().email(), otp: z.string().length(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and 6-digit OTP required' });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const record = await prisma.emailOtp.findFirst({
    where: { email, otp: parsed.data.otp, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    res.status(401).json({ error: 'Invalid or expired code. Please try again.' });
    return;
  }

  await prisma.emailOtp.update({ where: { id: record.id }, data: { used: true } });

  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    if (!user.isActive) {
      res.status(403).json({ error: 'Account deactivated' });
      return;
    }
    const accessToken = signAccess(user.id, user.role);
    const refreshToken = signRefresh(user.id);
    await prisma.refreshToken.create({
      data: { userId: user.id, token: refreshToken, expiresAt: new Date(Date.now() + REFRESH_MS) },
    });
    const { password: _pw, ...safeUser } = user;
    res.json({ isNewUser: false, user: safeUser, accessToken, refreshToken });
  } else {
    res.json({ isNewUser: true, email });
  }
});

// ── POST /api/auth/register-otp ─────────────────────────────────────────────
router.post('/register-otp', async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    firstName: z.string().min(1).max(40),
    lastName: z.string().min(1).max(40),
    phone: z.string().regex(/^\d{10}$/, 'Phone must be exactly 10 digits'),
    lat: z.number().optional(),
    lng: z.number().optional(),
    city: z.string().max(80).optional(),
    houseNo: z.string().max(100).optional(),
    street: z.string().max(200).optional(),
    pincode: z.string().max(10).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { email, firstName, lastName, phone, lat, lng, city, houseNo, street, pincode } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();
  const name = `${firstName.trim()} ${lastName.trim()}`;

  const conflict = await prisma.user.findFirst({
    where: { OR: [{ email: normalizedEmail }, { phone }] },
    select: { id: true },
  });
  if (conflict) {
    res.status(409).json({ error: 'Email or phone already registered' });
    return;
  }

  const randomPassword = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  const user = await prisma.user.create({
    data: { name, phone, email: normalizedEmail, password: randomPassword, role: 'BUYER', city, lat, lng, location: city },
    select: { id: true, name: true, phone: true, email: true, role: true, city: true, lat: true, lng: true, createdAt: true },
  });

  // Store address if provided
  const addressParts = [houseNo, street, city, pincode].filter(Boolean);
  if (addressParts.length > 0) {
    await prisma.address.create({
      data: { userId: user.id, label: 'Home', address: addressParts.join(', '), lat, lng },
    });
  }

  const accessToken = signAccess(user.id, user.role);
  const refreshToken = signRefresh(user.id);
  await prisma.refreshToken.create({
    data: { userId: user.id, token: refreshToken, expiresAt: new Date(Date.now() + REFRESH_MS) },
  });

  res.status(201).json({ user, accessToken, refreshToken });
});

export default router;
