import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import Slider from '@react-native-community/slider';
import { WebView } from 'react-native-webview';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const SCREEN_W = Dimensions.get('window').width;
import { SafeAreaView } from 'react-native-safe-area-context';

const C = {
  spice: '#E85D26',
  turmeric: '#F4A623',
  mint: '#2D9B6F',
  ink: '#1A1209',
  cream: '#FDFAF5',
  white: '#FFFFFF',
  warmGray: '#8A7F74',
  border: '#EDE8E0',
  blush: '#FDE8DC',
  paleGreen: '#E8F5EE',
  paleBlue: '#EEF2FF',
  paleYellow: '#FEF9EE',
} as const;

const LOCAL_API_BASE = 'http://192.168.15.135:3000/api';
const RENDER_API_BASE = 'https://foodsood.onrender.com/api';
const API_BASE = __DEV__ ? LOCAL_API_BASE : RENDER_API_BASE;
const BUYER_ACCESS_KEY = 'buyer_access_token';
const BUYER_REFRESH_KEY = 'buyer_refresh_token';
const MAX_LOCATION_IMAGE_BYTES = 30 * 1024;

function base64ByteSize(base64: string): number {
  const padding = (base64.match(/=*$/)?.[0].length ?? 0);
  return Math.floor((base64.length * 3) / 4) - padding;
}

function getLocationMapHtml(lat: number, lng: number, radiusKm: number): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
      crossorigin=""
    />
    <style>
      html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; }
      body { background: #f5f2ed; }
      .leaflet-container { font-family: sans-serif; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script
      src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
      integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
      crossorigin=""
    ></script>
    <script>
      var map = L.map('map', { zoomControl: false, attributionControl: false }).setView([${lat}, ${lng}], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
      }).addTo(map);
      var circle = L.circle([${lat}, ${lng}], {
        radius: ${radiusKm} * 1000,
        color: '#2D9B6F',
        weight: 2,
        fillColor: '#2D9B6F',
        fillOpacity: 0.12
      }).addTo(map);
      function sendCenter() {
        var center = map.getCenter();
        circle.setLatLng(center);
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'center',
            lat: center.lat,
            lng: center.lng
          }));
        }
      }
      map.whenReady(sendCenter);
      map.on('moveend', sendCenter);
    </script>
  </body>
</html>`;
}

function joinNoteParts(parts: string[], maxLen = 500): string {
  const filtered = parts.filter(Boolean);
  let note = '';
  for (const part of filtered) {
    const next = note ? `${note}\n${part}` : part;
    if (next.length > maxLen) break;
    note = next;
  }
  return note;
}

// Buyer device token ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â persisted in SecureStore so the buyer can track their own offers
async function getBuyerToken(): Promise<string> {
  const stored = await SecureStore.getItemAsync('buyer_device_token');
  if (stored) return stored;
  // generate a simple UUID v4
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  await SecureStore.setItemAsync('buyer_device_token', uuid);
  return uuid;
}

const BuyerTokens = {
  getAccess: () => SecureStore.getItemAsync(BUYER_ACCESS_KEY),
  getRefresh: () => SecureStore.getItemAsync(BUYER_REFRESH_KEY),
  set: async (access: string, refresh: string) => {
    await SecureStore.setItemAsync(BUYER_ACCESS_KEY, access);
    await SecureStore.setItemAsync(BUYER_REFRESH_KEY, refresh);
  },
  clear: async () => {
    await SecureStore.deleteItemAsync(BUYER_ACCESS_KEY);
    await SecureStore.deleteItemAsync(BUYER_REFRESH_KEY);
  },
};

async function refreshBuyerAccessToken(): Promise<string | null> {
  const refreshToken = await BuyerTokens.getRefresh();
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      await BuyerTokens.clear();
      return null;
    }
    const nextAccess = (data as { accessToken?: string }).accessToken;
    const nextRefresh = (data as { refreshToken?: string }).refreshToken;
    if (!nextAccess || !nextRefresh) {
      await BuyerTokens.clear();
      return null;
    }
    await BuyerTokens.set(nextAccess, nextRefresh);
    return nextAccess;
  } catch {
    return null;
  }
}

const REVIEW_PROMPT_DELAY_MS = 2 * 60 * 60 * 1000;
const REVIEW_SNOOZE_MS = 12 * 60 * 60 * 1000;
const MAX_REQUEST_QUOTES_PER_SIDE = 2;
const REVIEW_STORE_KEY = 'buyer_order_review_state';
const SAVED_CHEFS_STORE_KEY = 'buyer_saved_chefs';
const SEEN_NOTIFICATIONS_STORE_KEY = 'buyer_seen_notifications';

type ReviewPromptState = Record<string, {
  rating?: number;
  comment?: string;
  submittedAt?: string;
  snoozeUntil?: string;
}>;

interface DishOfferItem {
  id: string;
  dishId: string;
  chefId: string;
  buyerName: string;
  buyerToken: string;
  plates: number;
  offerPrice: number;
  agreedPrice?: number | null;
  holdUntil?: string | null;
  deliveryMode?: 'pickup' | 'delivery' | null;
  orderStatus?: 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | null;
  paymentRef?: string | null;
  paidAt?: string | null;
  message?: string;
  status: 'PENDING' | 'COUNTERED' | 'HOLD' | 'ADVANCE_PAID' | 'PAID' | 'REJECTED' | 'EXPIRED';
  paymentType?: 'FULL' | 'ADVANCE' | null;
  advancePaid?: number | null;
  counterPrice?: number | null;
  counterNote?: string | null;
  lastOfferBy: 'BUYER' | 'CHEF';
  dishName: string;
  dishEmoji: string;
  createdAt: string;
  updatedAt: string;
}

interface BuyerRequestQuoteApi {
  id: string;
  chefId: string;
  price: number;
  cookTime: string;
  delivery: 'pickup' | 'delivery' | 'both';
  message?: string | null;
  style?: string | null;
  status: 'PENDING' | 'COUNTERED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN';
  counterOffer?: number | null;
  chefQuoteCount?: number;
  buyerCounterCount?: number;
  createdAt: string;
  chef: {
    id: string;
    name: string;
    avatar?: string | null;
    rating: number;
    ratingCount: number;
    totalOrders: number;
    cookingStyle?: string | null;
    city?: string | null;
  };
}

interface BuyerRequestApi {
  id: string;
  dishName: string;
  category: string;
  qty: number;
  people: number;
  spiceLevel: string;
  preferences: string[];
  delivery: 'pickup' | 'delivery';
  budget: number;
  notes?: string | null;
  status: string;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
  createdAt: string;
  distanceKm?: number | null;
  quotesCount: number;
  quotes?: BuyerRequestQuoteApi[];
  order?: {
    id: string;
    status: 'CONFIRMED' | 'COOKING' | 'READY' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
    finalPrice: number;
    paymentStatus?: 'HOLD' | 'ADVANCE_PAID' | 'PAID' | 'EXPIRED';
    paymentType?: 'FULL' | 'ADVANCE' | null;
    advancePaid?: number | null;
    holdUntil?: string | null;
    paymentRef?: string | null;
    paidAt?: string | null;
    cookingStartedAt?: string | null;
    readyAt?: string | null;
  } | null;
  user: {
    id: string;
    name: string;
    rating: number;
    avatar?: string | null;
    city?: string | null;
  };
}

interface BuyerQuoteCardItem {
  id: string;
  initial: string;
  avatarColor: string;
  name: string;
  rating: string;
  orders: string;
  distance: string;
  price: number;
  cookTime: string;
  delivery: string;
  style: string;
  buyerCountersLeft: number;
  chefCountersLeft: number;
  isBest: boolean;
  accentColor: string;
  rawQuote: BuyerRequestQuoteApi;
}

interface BuyerProfile {
  id: string;
  name: string;
  phone: string;
  email?: string;
  role: string;
  city?: string | null;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
  createdAt?: string;
}

interface BuyerAddress {
  id: string;
  label: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
}

interface BuyerAuthResponse {
  user: BuyerProfile;
  accessToken: string;
  refreshToken: string;
}

interface BuyerNotificationCard {
  id: string;
  emoji: string;
  emojiBg: string;
  name: string;
  by: string;
  status: string;
  statusBg: string;
  statusColor: string;
  tags: string[];
  price: string;
  priceLabel: string;
  secondaryPrice?: string;
  secondaryPriceLabel?: string;
  quotesCount: string;
  quotesLabel: string;
  quotesBg: string;
  target: 'request' | 'orders';
  rawRequest?: BuyerRequestApi;
  rawOffer?: DishOfferItem;
  activityAt: string;
}

interface BuyerRequestOrderItem {
  id: string;
  requestId: string;
  quoteId: string;
  buyerId: string;
  chefId: string;
  finalPrice: number;
  status: 'CONFIRMED' | 'COOKING' | 'READY' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';
  paymentStatus: 'HOLD' | 'ADVANCE_PAID' | 'PAID' | 'EXPIRED';
  paymentType?: 'FULL' | 'ADVANCE' | null;
  advancePaid?: number | null;
  holdUntil?: string | null;
  paymentRef?: string | null;
  paidAt?: string | null;
  cookingStartedAt?: string | null;
  readyAt?: string | null;
  address?: string | null;
  createdAt: string;
  updatedAt: string;
  request: {
    id: string;
    dishName: string;
    category: string;
    qty: number;
    people: number;
    spiceLevel: string;
    preferences: string[];
    delivery: 'pickup' | 'delivery';
  };
  quote: {
    id: string;
    price: number;
    cookTime: string;
    style?: string | null;
    delivery: 'pickup' | 'delivery' | 'both';
  };
  buyer: {
    id: string;
    name: string;
    phone: string;
    avatar?: string | null;
  };
  chef?: {
    id: string;
    name: string;
    avatar?: string | null;
  };
}

function mapBuyerQuoteCard(request: BuyerRequestApi, quote: BuyerRequestQuoteApi, index: number, quoteCount: number): BuyerQuoteCardItem {
  const accentColor = QUOTE_ACCENT_COLORS[index % QUOTE_ACCENT_COLORS.length];
  const finalPrice = quote.status === 'COUNTERED'
    ? (quote.counterOffer ?? quote.price)
    : quote.price;
  return {
    id: quote.id,
    initial: quote.chef.name[0]?.toUpperCase() ?? 'C',
    avatarColor: accentColor,
    name: quote.chef.name,
    rating: quote.chef.rating.toFixed(1),
    orders: String(quote.chef.totalOrders),
    distance: request.distanceKm != null ? `${request.distanceKm} km` : 'Nearby',
    price: finalPrice,
    cookTime: quote.cookTime,
    delivery: quote.delivery === 'both' ? 'Pickup / Delivery' : quote.delivery === 'pickup' ? 'Pickup' : 'Delivery',
    style: quote.style || quote.chef.cookingStyle || 'Home style',
    buyerCountersLeft: Math.max(0, (MAX_REQUEST_QUOTES_PER_SIDE - 1) - (quote.buyerCounterCount ?? 0)),
    chefCountersLeft: Math.max(0, MAX_REQUEST_QUOTES_PER_SIDE - (quote.chefQuoteCount ?? 1)),
    isBest: index === 0 && quoteCount > 1,
    accentColor,
    rawQuote: quote,
  };
}

function getLatestBuyerRequestQuote(request: BuyerRequestApi): BuyerRequestQuoteApi | null {
  if (!request.quotes?.length) return null;
  return [...request.quotes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
}

function getAcceptedBuyerRequestPrice(request: BuyerRequestApi): number | null {
  if (request.order?.finalPrice != null) return request.order.finalPrice;
  const acceptedQuote = request.quotes?.find((quote) => quote.status === 'ACCEPTED') ?? null;
  if (!acceptedQuote) return null;
  return acceptedQuote.counterOffer ?? acceptedQuote.price;
}

function getNotificationVersionKey(item: BuyerNotificationCard): string {
  return `${item.id}:${item.activityAt}`;
}

function getOfferOrderStatus(offer: DishOfferItem): 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' {
  if (offer.orderStatus === 'OUT_FOR_DELIVERY' || offer.orderStatus === 'DELIVERED') return offer.orderStatus;
  return 'CONFIRMED';
}

function getOfferOrderStatusLabel(offer: DishOfferItem): string {
  const status = getOfferOrderStatus(offer);
  if (status === 'OUT_FOR_DELIVERY') return offer.deliveryMode === 'delivery' ? 'Dispatched' : 'Ready';
  if (status === 'DELIVERED') return 'Delivered';
  return 'Confirmed';
}

function countdownTo(iso?: string | null): string | null {
  if (!iso) return null;
  const remaining = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (remaining <= 0) return '0m 00s';
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

async function buyerApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const send = async (token?: string | null) => fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  let token = await BuyerTokens.getAccess();
  let res = await send(token);

  if (res.status === 401) {
    const refreshedToken = await refreshBuyerAccessToken();
    if (refreshedToken) {
      token = refreshedToken;
      res = await send(token);
    }
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}


const HOME_CATEGORIES = [
  { id: '1', emoji: '\uD83C\uDF57', label: 'Chicken', bg: C.blush },
  { id: '2', emoji: '\uD83E\uDD58', label: 'Thali', bg: '#FFF2D8' },
  { id: '3', emoji: '\uD83E\uDDC0', label: 'Paneer', bg: '#FDEEDB' },
  { id: '4', emoji: '\uD83C\uDF5A', label: 'Rice', bg: C.paleYellow },
  { id: '5', emoji: '\uD83C\uDF5B', label: 'Curry', bg: '#FDE8DC' },
  { id: '6', emoji: '\uD83E\uDD6C', label: 'Veg', bg: C.paleGreen },
  { id: '7', emoji: '\uD83E\uDD69', label: 'Mutton', bg: '#FEEFEE' },
  { id: '8', emoji: '\uD83D\uDC1F', label: 'Fish', bg: '#E7F4FF' },
  { id: '9', emoji: '\uD83C\uDF62', label: 'Snacks', bg: '#FFF0E8' },
  { id: '10', emoji: '\uD83C\uDF5C', label: 'Noodles', bg: '#F3E8FF' },
  { id: '11', emoji: '\uD83E\uDED3', label: 'Roti', bg: '#F9EEDB' },
  { id: '12', emoji: '\uD83C\uDF70', label: 'Desserts', bg: C.paleBlue },
];

const REQUESTS = [
  {
    id: '1',
    emoji: '\uD83C\uDF57',
    emojiBg: C.blush,
    name: 'Chicken Curry',
    by: 'by You | 20 min ago',
    distanceKm: 0,
    status: 'Negotiating',
    statusBg: C.paleYellow,
    statusColor: '#B07800',
    tags: ['Extra Spicy', '1 kg', 'Bone-in'],
    price: '\u20B9300',
    priceLabel: 'Your budget',
    quotesCount: '3',
    quotesLabel: 'quotes received',
    quotesBg: C.spice,
  },
  {
    id: '2',
    emoji: '\uD83E\uDD63',
    emojiBg: C.paleGreen,
    name: 'Dal Makhani',
    by: 'Meena R. | 0.6 km',
    distanceKm: 0.6,
    status: 'Open',
    statusBg: '#EEF9F4',
    statusColor: C.mint,
    tags: ['No Onion', '1L', 'Jain'],
    price: '\u20B9200',
    priceLabel: 'Budget',
    quotesCount: '0',
    quotesLabel: 'quotes',
    quotesBg: C.mint,
  },
  {
    id: '3',
    emoji: '\uD83C\uDF70',
    emojiBg: C.paleBlue,
    name: 'Chocolate Cake',
    by: 'Kavya B. | 1.2 km',
    distanceKm: 1.2,
    status: 'Cooking',
    statusBg: C.paleBlue,
    statusColor: '#4F6CF5',
    tags: ['Eggless', 'Ganache', 'Delivery'],
    price: '\u20B9350',
    priceLabel: 'Agreed',
    quotesCount: '45 min',
    quotesLabel: 'until ready',
    quotesBg: '#4F6CF5',
  },
];

const COOKING_NEARBY = [
  {
    id: '1',
    emoji: '\uD83C\uDF57',
    emojiBg: '#FDE8DC',
    chefName: 'Priya Mehta',
    chefInitial: 'P',
    dish: 'Chicken Kosha',
    distance: '0.4 km',
    distanceKm: 0.4,
    status: 'ready' as const,
    etaMin: 0,
    imageUri: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/65/Chicken-curry.jpg/320px-Chicken-curry.jpg',
    serves: 4,
    price: 320,
    rating: 4.9,
    tags: ['Spicy', 'Bone-in', 'Bengali'],
  },
  {
    id: '2',
    emoji: '\uD83E\uDD63',
    emojiBg: '#E8F5EE',
    chefName: 'Meena Roy',
    chefInitial: 'M',
    dish: 'Dal Makhani + Rice',
    distance: '0.9 km',
    distanceKm: 0.9,
    status: 'cooking' as const,
    etaMin: 18,
    imageUri: null,
    serves: 2,
    price: 180,
    rating: 4.7,
    tags: ['Jain', 'No Onion', 'Light'],
  },
  {
    id: '3',
    emoji: '\uD83C\uDF70',
    emojiBg: '#EEF2FF',
    chefName: 'Kavya Bose',
    chefInitial: 'K',
    dish: 'Chocolate Ganache Cake',
    distance: '1.2 km',
    distanceKm: 1.2,
    status: 'cooking' as const,
    etaMin: 34,
    imageUri: null,
    serves: 6,
    price: 350,
    rating: 5.0,
    tags: ['Eggless', 'Delivery', 'Custom'],
  },
];

const FOOD_CATEGORIES = [
  { id: '1', emoji: '\uD83C\uDF57', label: 'Chicken' },
  { id: '2', emoji: '\uD83E\uDD69', label: 'Mutton' },
  { id: '3', emoji: '\uD83C\uDF5A', label: 'Biryani' },
  { id: '4', emoji: '\uD83E\uDD58', label: 'Thali' },
  { id: '5', emoji: '\uD83E\uDDC0', label: 'Paneer' },
  { id: '6', emoji: '\uD83E\uDD63', label: 'Dal' },
  { id: '7', emoji: '\uD83D\uDC1F', label: 'Fish' },
  { id: '8', emoji: '\uD83C\uDF62', label: 'Snacks' },
  { id: '9', emoji: '\uD83E\uDED3', label: 'Roti' },
  { id: '10', emoji: '\uD83C\uDF5C', label: 'Noodles' },
  { id: '11', emoji: '\uD83C\uDF70', label: 'Dessert' },
  { id: '12', emoji: '\u270F\uFE0F', label: 'Custom' },
];

const SPICE_LEVELS = [
  { id: 'mild', label: 'Mild' },
  { id: 'medium', label: 'Medium' },
  { id: 'extra', label: 'Extra' },
];

const PREFS = [
  { id: 'bone', label: 'Bone-in' },
  { id: 'boneless', label: 'Boneless' },
  { id: 'noegg', label: 'No Egg' },
  { id: 'noonion', label: 'No Onion' },
  { id: 'nogarlic', label: 'No Garlic' },
  { id: 'lessoil', label: 'Less Oil' },
  { id: 'mustardoil', label: 'Mustard Oil' },
  { id: 'refinedoil', label: 'Refined Oil' },
  { id: 'potato', label: 'Potato' },
  { id: 'capsicum', label: 'Capsicum' },
  { id: 'coriander', label: 'Coriander' },
  { id: 'redchilli', label: 'Red Chilli' },
  { id: 'greenchilli', label: 'Green Chilli' },
];

const DELIVERY = [
  { id: 'pickup', label: 'Self Pickup - 5% Off' },
  { id: 'delivery', label: 'Home Delivery' },
];

const QUOTE_ACCENT_COLORS = [C.mint, '#4F6CF5', '#7C3AED', C.spice] as const;

const timeAgo = (iso: string) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(1, Math.floor(diffMs / 60000));
  if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr${hours > 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
};

const holdTimeLeft = (holdUntil?: string | null) => {
  if (!holdUntil) return null;
  const remaining = Math.floor((new Date(holdUntil).getTime() - Date.now()) / 1000);
  if (remaining <= 0) return null;
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const formatMemberSince = (iso?: string) => {
  if (!iso) return 'Member since recently';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Member since recently';
  return `Member since ${date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`;
};

const MENU_GROUPS = [
  {
    title: 'My Activity',
    items: [
      { icon: '\u25A3', iconBg: C.blush, label: 'My Orders', sub: '18 orders placed', badge: null },
      { icon: '\u270E', iconBg: C.paleGreen, label: 'My Requests', sub: '1 active | 4 completed', badge: '1' },
      { icon: '\u2605', iconBg: C.paleBlue, label: 'My Reviews', sub: "Reviews I\'ve left", badge: null },
      { icon: '\u2665', iconBg: '#FEE2E2', label: 'Saved Chefs', sub: '3 favourite chefs', badge: null },
    ],
  },
  {
    title: 'Account',
    items: [
      { icon: '\u2302', iconBg: C.paleYellow, label: 'Saved Addresses', sub: 'Home, Office', badge: null },
      { icon: '\u20B9', iconBg: '#F3E8FF', label: 'Payment Methods', sub: 'UPI | Cash', badge: null },
      { icon: '\u25CB', iconBg: C.paleGreen, label: 'Notifications', sub: 'Quotes, updates', badge: '2' },
      { icon: '\u25CF', iconBg: '#F1F5F9', label: 'Privacy & Security', sub: 'Password, 2FA', badge: null },
    ],
  },
  {
    title: 'Support',
    items: [
      { icon: '?', iconBg: '#EEF2FF', label: 'Help & Support', sub: 'FAQs, chat with us', badge: null },
      { icon: '!', iconBg: '#FEF9EE', label: 'Report an Issue', sub: 'Order problems', badge: null },
      { icon: 'i', iconBg: C.cream, label: 'About App', sub: 'Version 1.0.0', badge: null },
    ],
  },
];

const QUOTES = [
  { id: '1', initial: 'P', avatarColor: C.spice, name: 'Priya Mehta', rating: '4.9', orders: '124', distance: '0.4 km', price: 300, cookTime: '~2 hrs', delivery: 'Pickup', style: 'Bengali', isBest: true, accentColor: C.mint },
  { id: '2', initial: 'R', avatarColor: C.mint, name: 'Ranjit Dubey', rating: '4.7', orders: '89', distance: '0.8 km', price: 320, cookTime: '~2.5 hrs', delivery: 'Delivery', style: 'Mughlai', isBest: false, accentColor: '#4F6CF5' },
  { id: '3', initial: 'S', avatarColor: '#4F6CF5', name: 'Sunita Krishnan', rating: '4.8', orders: '201', distance: '1.1 km', price: 350, cookTime: '~2 hrs', delivery: 'Both', style: 'South Indian', isBest: false, accentColor: '#7C3AED' },
];

const CHEF_PROFILE = {
  name: 'Priya Mehta',
  initial: 'P',
  location: 'Your area',
  since: '2022',
  rating: 4.9,
  ratingCount: 47,
  orders: 124,
  responseTime: '~12 min',
  bio: 'Passionate home cook with 15 years of experience. I bring authentic Bengali and Mughlai flavors to your doorstep using fresh, locally sourced ingredients. Every dish is cooked with love, no shortcuts, no compromises.',
  culinaryStyles: ['Bengali', 'Mughlai', 'North Indian', 'Continental'],
  specialities: [
    { emoji: '\uD83C\uDF57', name: 'Chicken Curry' },
    { emoji: '\uD83E\uDD69', name: 'Mutton Biryani' },
    { emoji: '\uD83E\uDD63', name: 'Dal Makhani' },
    { emoji: '\uD83C\uDF70', name: 'Mishti Doi' },
    { emoji: '\uD83D\uDC1F', name: 'Fish Curry' },
    { emoji: '\uD83E\uDD54', name: 'Posto Aloo' },
  ],
  reviews: [
    { id: '1', initial: 'R', name: 'Rohan C.', rating: 5, comment: 'Amazing chicken curry! Perfectly spiced and delivered right on time. Will definitely order again.', date: '18 Mar' },
    { id: '2', initial: 'M', name: 'Meena R.', rating: 4, comment: 'Loved the biryani. Generous portions and great taste. Packaging was very neat too!', date: '12 Mar' },
    { id: '3', initial: 'A', name: 'Aftab S.', rating: 5, comment: "Best home-cooked food I\'ve had in years. Feels like maa ka khana, full of warmth.", date: '5 Mar' },
  ],
  earnings: { month: 12450, total: 89200 },
};

type Screen = 'auth' | 'home' | 'explore' | 'post-request' | 'request-floated' | 'quotes' | 'orders' | 'profile' | 'chef-profile' | 'public-chef';

type PublicChef = {
  id: string;
  name: string;
  initial: string;
  dish: string;
  distance: string;
  rating: number;
  tags: string[];
  price: number;
  eta: string;
  serves: number;
  avatar?: string | null;
};

type SavedChef = {
  id: string;
  name: string;
  initial: string;
  dish: string;
  distance: string;
  rating: number;
  tags: string[];
  price: number;
  eta: string;
  serves: number;
  avatar?: string | null;
  city?: string | null;
  savedAt: string;
};

type PublicChefProfileApi = {
  id: string;
  name: string;
  avatar?: string | null;
  coverImage?: string | null;
  bio?: string | null;
  cookingStyle?: string | null;
  city?: string | null;
  rating: number;
  ratingCount: number;
  totalOrders: number;
  createdAt: string;
  kitchenImages?: string[];
  specialityDishes?: Array<{
    dishName: string;
    imageUrl: string;
    description: string;
    lastSoldPrice: number;
    unitsSold: number;
    ratingAverage: number;
    ratingCount: number;
    recentReviews: Array<{
      buyerName: string;
      rating: number;
      comment?: string;
      createdAt: string;
    }>;
  }>;
  reviewsReceived: Array<{
    id: string;
    rating: number;
    comment?: string | null;
    createdAt: string;
    reviewer: { id: string; name: string; avatar?: string | null };
  }>;
};

type CookingFeedApiItem = {
  id: string;
  emoji: string;
  dishName: string;
  cuisine: string;
  tags: string[];
  pricePerPlate: number;
  plates: number;
  portionType: 'quantity' | 'pieces';
  portionValue: number;
  portionUnit: string;
  readyInMinutes: number;
  notes?: string | null;
  imageUrl?: string | null;
  status: 'cooking' | 'ready';
  remainingMinutes: number;
  readyAt: string;
  distanceKm?: number | null;
  chef?: {
    id: string;
    name: string;
    avatar?: string | null;
    city?: string | null;
    location?: string | null;
    rating: number;
  };
};

type CookingFeedCard = {
  id: string;
  chefId: string;
  emoji: string;
  emojiBg: string;
  chefName: string;
  chefInitial: string;
  dish: string;
  distance: string;
  distanceKm: number | null;
  status: 'cooking' | 'ready';
  etaMin: string;
  readyAt: string;
  imageUri: string | null;
  serves: number;
  price: number;
  rating: number;
  tags: string[];
};


const emojiBgFor = (emoji: string) => {
  const bgMap: Record<string, string> = {
    '\uD83C\uDF57': C.blush,
    '\uD83E\uDD69': '#FEEFEE',
    '\uD83E\uDD54': C.paleGreen,
    '\uD83C\uDF70': C.paleBlue,
    '\uD83C\uDF5A': C.paleYellow,
    '\uD83C\uDF5B': '#FFF1E8',
    '\uD83C\uDF5C': '#F3E8FF',
    '\uD83E\uDD63': '#FDEEDC',
    '\u270F\uFE0F': C.cream,
  };
  return bgMap[emoji] ?? C.cream;
};

const mapCookingFeedItem = (item: CookingFeedApiItem): CookingFeedCard => ({

  id: item.id,
  chefId: item.chef?.id ?? '',
  emoji: item.emoji,
  emojiBg: emojiBgFor(item.emoji),
  chefName: item.chef?.name ?? 'Chef',
  chefInitial: (item.chef?.name?.[0] ?? 'C').toUpperCase(),
  dish: item.dishName,
  distance: item.distanceKm != null ? `${item.distanceKm} km` : item.chef?.city ?? item.chef?.location ?? 'Nearby',
  distanceKm: item.distanceKm ?? null,
  status: item.status,
  etaMin: item.readyAt,
  readyAt: item.readyAt,
  imageUri: item.imageUrl ?? null,
  serves: item.plates,
  price: item.pricePerPlate,
  rating: item.chef?.rating ?? 0,
  tags: [item.cuisine, ...item.tags].filter(Boolean),
});

type FloatedDish = {
  dishName: string;
  emoji?: string;
  qtyGrams: number;
  servings: number;
  quantityLabel?: string;
  servingNote?: string;
  spiceLevel: string;
  delivery: string;
  budget: number;
  remarks?: string;
  sides?: Array<{ id: string; label: string; unit: string; qty: number }>;
  lat?: number;
  lng?: number;
  geoRadius: number;
};

const SIDE_OPTIONS = [
  { id: 'roti', label: 'Roti', unit: 'pieces' },
  { id: 'rice', label: 'Plain Rice', unit: 'portions' },
  { id: 'salad', label: 'Salad', unit: 'portion' },
  { id: 'raita', label: 'Raita', unit: 'portion' },
  { id: 'mosoor-daal', label: 'Mosoor Daal', unit: 'portion' },
  { id: 'chutney', label: 'Chutney', unit: 'portion' },
  { id: 'papad', label: 'Papad', unit: 'pieces' },
];

const THALI_INCLUDES = '1 bhaja, 2 sabji, daal, chicken/fish/mutton/paneer, chutney, papad';

const FOOD_PORTION_GUIDE: Record<string, { gramsPerPerson: number; helper: string }> = {
  '1': { gramsPerPerson: 200, helper: 'Chicken guide: around 4 pieces = 200 g for 1 person' },
  '2': { gramsPerPerson: 220, helper: 'Mutton guide: around 220 g usually serves 1 person' },
  '3': { gramsPerPerson: 300, helper: 'Biryani guide: around 300 g usually serves 1 person' },
  '4': { gramsPerPerson: 400, helper: 'Thali guide: around 400 g usually serves 1 person' },
  '5': { gramsPerPerson: 180, helper: 'Paneer guide: around 180 g usually serves 1 person' },
  '6': { gramsPerPerson: 220, helper: 'Dal guide: around 220 g usually serves 1 person' },
  '7': { gramsPerPerson: 200, helper: 'Fish guide: around 200 g usually serves 1 person' },
  '8': { gramsPerPerson: 150, helper: 'Snack guide: around 150 g usually serves 1 person' },
  '9': { gramsPerPerson: 160, helper: 'Roti guide: around 160 g usually serves 1 person' },
  '10': { gramsPerPerson: 250, helper: 'Noodle guide: around 250 g usually serves 1 person' },
  '11': { gramsPerPerson: 120, helper: 'Dessert guide: around 120 g usually serves 1 person' },
  '12': { gramsPerPerson: 200, helper: 'Custom guide: around 200 g usually serves 1 person' },
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [booting, setBooting] = useState(true);
  const [buyerProfile, setBuyerProfile] = useState<BuyerProfile | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authName, setAuthName] = useState('');
  const [authPhone, setAuthPhone] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // Email OTP auth flow
  const [authStep, setAuthStep] = useState<'email' | 'otp' | 'register'>('email');
  const [authEmail, setAuthEmail] = useState('');
  const [authOtp, setAuthOtp] = useState('');
  const [authFirstName, setAuthFirstName] = useState('');
  const [authLastName, setAuthLastName] = useState('');
  const [authRegPhone, setAuthRegPhone] = useState('');
  const [authAddrHouse, setAuthAddrHouse] = useState('');
  const [authAddrStreet, setAuthAddrStreet] = useState('');
  const [authAddrCity, setAuthAddrCity] = useState('');
  const [authAddrPincode, setAuthAddrPincode] = useState('');
  const [authGpsCoords, setAuthGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [authGpsLabel, setAuthGpsLabel] = useState('');
  const [authGpsLocating, setAuthGpsLocating] = useState(false);
  const [otpBusy, setOtpBusy] = useState(false);
  const [selectedCat, setSelectedCat] = useState('1');
  const [feedTab, setFeedTab] = useState<'requests' | 'cooking'>('requests');
  const [cookingFeed, setCookingFeed] = useState<CookingFeedCard[]>([]);
  const [cookingLoading, setCookingLoading] = useState(false);
  const [cookingTick, setCookingTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setCookingTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const cookTimeLeft = (readyAt: string | number) => {
    const remaining = typeof readyAt === 'string'
      ? Math.floor((new Date(readyAt).getTime() - Date.now()) / 1000)
      : readyAt * 60;
    if (remaining <= 0) return null;
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
  };

  const [selectedFood, setSelectedFood] = useState('1');
  const [dishName, setDishName] = useState('Chicken Curry');
  const [dishNameSuggestions, setDishNameSuggestions] = useState<string[]>([]);
  const [dishNameFocused, setDishNameFocused] = useState(false);
  const [qtyGrams, setQtyGrams] = useState(0);
  const [thaliPlates, setThaliPlates] = useState(1);
  const [spice, setSpice] = useState('extra');
  const [prefs, setPrefs] = useState(['bone']);
  const [showAllPrefs, setShowAllPrefs] = useState(false);
  const [sideQty, setSideQty] = useState<Record<string, number>>({});
  const [showSides, setShowSides] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [delivery, setDelivery] = useState('pickup');
  const [budget, setBudget] = useState(300);
  const [notifEnabled, setNotifEnabled] = useState(true);
  const [quotesBudget, setQuotesBudget] = useState(300);
  const [counterChef, setCounterChef] = useState<BuyerQuoteCardItem | null>(null);
  const [floatedDish, setFloatedDish] = useState<FloatedDish | null>(null);
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);
  const [currentRequest, setCurrentRequest] = useState<BuyerRequestApi | null>(null);
  const [myRequests, setMyRequests] = useState<BuyerRequestApi[]>([]);
  const [myOffers, setMyOffers] = useState<DishOfferItem[]>([]);
  const [myRequestOrders, setMyRequestOrders] = useState<BuyerRequestOrderItem[]>([]);
  const [seenNotificationKeys, setSeenNotificationKeys] = useState<string[]>([]);
  const [seenNotificationsReady, setSeenNotificationsReady] = useState(false);
  const [negSheetDismissed, setNegSheetDismissed] = useState(false);
  const [postingRequest, setPostingRequest] = useState(false);
  const [location, setLocation] = useState('Set your location');
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoRadius, setGeoRadius] = useState(2);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [showLocationMapModal, setShowLocationMapModal] = useState(false);
  const [locationSearch, setLocationSearch] = useState('');
  const [draftMapCoords, setDraftMapCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [mapModalHtml, setMapModalHtml] = useState<string | null>(null);
  const [draftMapLocationName, setDraftMapLocationName] = useState('Locating...');
  const [draftMapLocationLoading, setDraftMapLocationLoading] = useState(false);
  const [addressLabelType, setAddressLabelType] = useState<'Home' | 'Office' | 'Other'>('Home');
  const [customAddressLabel, setCustomAddressLabel] = useState('');
  const [savedAddresses, setSavedAddresses] = useState<BuyerAddress[]>([]);
  const [savedAddressesReady, setSavedAddressesReady] = useState(false);
  const [locationAddress, setLocationAddress] = useState('');
  const [locationLandmark, setLocationLandmark] = useState('');
  const [buildingImageUri, setBuildingImageUri] = useState<string | null>(null);
  const [buildingImageData, setBuildingImageData] = useState<string | null>(null);
  const [buildingImageUrl, setBuildingImageUrl] = useState<string | null>(null);
  const [buildingImageSize, setBuildingImageSize] = useState<number | null>(null);
  const [buildingImageBusy, setBuildingImageBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const mapWebViewRef = useRef<WebView>(null);
  const mapLookupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapLookupSeqRef = useRef(0);
  const buyerDisplayName = buyerProfile?.name ?? 'Buyer';
  const buyerInitial = buyerDisplayName.trim().charAt(0).toUpperCase() || 'B';
  const filteredCooking = cookingFeed;

  const loadCookingFeed = async (coordsOverride?: { lat: number; lng: number } | null) => {
    setCookingLoading(true);
    try {
      const coords = coordsOverride === undefined ? userCoords : coordsOverride;
      const qs = new URLSearchParams({ limit: '30', radiusKm: String(geoRadius) });
      if (coords) {
        qs.set('lat', String(coords.lat));
        qs.set('lng', String(coords.lng));
      }
      const res = await fetch(`${API_BASE}/cooking?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Failed to load cooking feed');
      setCookingFeed((data as CookingFeedApiItem[]).map(mapCookingFeedItem));
    } catch {
      setCookingFeed([]);
    } finally {
      setCookingLoading(false);
    }
  };

  useEffect(() => {
    if (screen !== 'home' && screen !== 'explore') return;
    loadCookingFeed();
    const id = setInterval(() => {
      loadCookingFeed();
    }, 10000);
    return () => clearInterval(id);
  }, [screen, geoRadius, userCoords]);

  useEffect(() => {
    const loadDishSuggestions = async () => {
      try {
        const res = await fetch(`${API_BASE}/users/dish-suggestions?limit=50`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data)) {
          setDishNameSuggestions(data.filter((item): item is string => typeof item === 'string'));
        }
      } catch {
        setDishNameSuggestions([]);
      }
    };
    loadDishSuggestions();
  }, []);

  const loadSavedAddresses = async () => {
    if (!buyerProfile) {
      setSavedAddresses([]);
      setSavedAddressesReady(true);
      return;
    }
    setSavedAddressesReady(false);
    try {
      const items = await buyerApi<BuyerAddress[]>('/users/me/addresses');
      setSavedAddresses(items);
    } catch {
      setSavedAddresses([]);
    } finally {
      setSavedAddressesReady(true);
    }
  };

  useEffect(() => {
    loadSavedAddresses();
  }, [buyerProfile?.id]);

  useEffect(() => {
    if (!showLocationMapModal || !draftMapCoords) return;
    if (mapLookupTimeoutRef.current) clearTimeout(mapLookupTimeoutRef.current);
    const seq = ++mapLookupSeqRef.current;
    setDraftMapLocationLoading(true);
    mapLookupTimeoutRef.current = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({
          format: 'jsonv2',
          lat: String(draftMapCoords.lat),
          lon: String(draftMapCoords.lng),
          zoom: '18',
          addressdetails: '1',
        });
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${qs.toString()}`, {
          headers: {
            'Accept': 'application/json',
            'Accept-Language': 'en',
          },
        });
        const data = await res.json() as { display_name?: string };
        if (mapLookupSeqRef.current !== seq) return;
        setDraftMapLocationName(data.display_name || 'Location name unavailable');
      } catch {
        if (mapLookupSeqRef.current !== seq) return;
        setDraftMapLocationName('Location name unavailable');
      } finally {
        if (mapLookupSeqRef.current === seq) setDraftMapLocationLoading(false);
      }
    }, 450);
    return () => {
      if (mapLookupTimeoutRef.current) clearTimeout(mapLookupTimeoutRef.current);
    };
  }, [draftMapCoords, showLocationMapModal]);

  useEffect(() => {
    if (!showLocationMapModal) return;
    mapWebViewRef.current?.injectJavaScript(`
      if (typeof circle !== 'undefined') {
        circle.setRadius(${geoRadius} * 1000);
      }
      true;
    `);
  }, [geoRadius, showLocationMapModal]);

  const loadCurrentRequest = async (requestId: string) => {
    try {
      const res = await fetch(`${API_BASE}/requests/${requestId}`);
      if (!res.ok) return;
      const data = await res.json();
      const request = data as BuyerRequestApi;
      setCurrentRequest({
        ...request,
        quotesCount: request.quotes?.filter((quote) => quote.status === 'PENDING' || quote.status === 'COUNTERED').length ?? 0,
      });
    } catch {
      // ignore background polling errors
    }
  };

  const applySelectedCoords = async (latitude: number, longitude: number) => {
    setUserCoords({ lat: latitude, lng: longitude });
    const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (place) {
      const shortParts = [place.city || place.subregion, place.region].filter(Boolean);
      const addressParts = [
        place.name,
        place.street,
        place.district,
        place.city || place.subregion,
        place.region,
        place.postalCode,
        place.country,
      ].filter(Boolean);
      const nextLocation = shortParts.join(', ') || addressParts.join(', ');
      setLocation(nextLocation);
      setLocationSearch(nextLocation);
      setLocationAddress(addressParts.join(', '));
      setLocationLandmark(place.name && place.street && place.name !== place.street ? place.name : '');
    }
  };

  const useCurrentLocation = async () => {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission denied', 'Allow location access to auto-detect your area.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;
      setDraftMapCoords({ lat: latitude, lng: longitude });
      setMapModalHtml(getLocationMapHtml(latitude, longitude, geoRadius));
      setDraftMapLocationName('Locating...');
      setShowLocationMapModal(true);
    } catch {
      Alert.alert('Error', 'Could not fetch your location. Try again.');
    } finally {
      setLocating(false);
    }
  };

  const confirmMapLocation = async () => {
    if (!draftMapCoords) return;
    setLocating(true);
    try {
      await applySelectedCoords(draftMapCoords.lat, draftMapCoords.lng);
      setShowLocationMapModal(false);
    } catch {
      Alert.alert('Error', 'Could not confirm that map location. Try again.');
    } finally {
      setLocating(false);
    }
  };

  const pickBuildingImage = async () => {
    setBuildingImageBusy(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Permission denied', 'Allow gallery access to upload a building photo.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.7,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      let width = Math.min(asset.width ?? 720, 720);
      let compress = 0.45;
      let best: { uri: string; base64: string; bytes: number } | null = null;

      for (let attempt = 0; attempt < 7; attempt += 1) {
        const manipulated = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: Math.max(180, Math.round(width)) } }],
          { compress: Math.max(0.05, compress), format: ImageManipulator.SaveFormat.JPEG, base64: true },
        );
        if (!manipulated.base64) continue;
        const bytes = base64ByteSize(manipulated.base64);
        best = { uri: manipulated.uri, base64: manipulated.base64, bytes };
        if (bytes <= MAX_LOCATION_IMAGE_BYTES) break;
        width *= 0.82;
        compress -= 0.07;
      }

      if (!best || best.bytes > MAX_LOCATION_IMAGE_BYTES) {
        Alert.alert('Image too large', 'Try a clearer crop or a smaller image. The building photo must be under 30 KB.');
        return;
      }

      setBuildingImageUri(best.uri);
      setBuildingImageData(`data:image/jpeg;base64,${best.base64}`);
      setBuildingImageSize(best.bytes);
      setBuildingImageUrl(null);
    } catch {
      Alert.alert('Upload failed', 'Could not prepare the building image.');
    } finally {
      setBuildingImageBusy(false);
    }
  };

  const uploadBuildingImageIfNeeded = async () => {
    if (!buildingImageData || buildingImageUrl || !buyerProfile) return buildingImageUrl;
    const uploaded = await buyerApi<{ url: string }>('/users/me/kitchen-image', {
      method: 'POST',
      body: JSON.stringify({ imageData: buildingImageData }),
    });
    setBuildingImageUrl(uploaded.url);
    return uploaded.url;
  };

  const saveLocationSelection = async () => {
    const nextLocation = (userCoords ? location : locationSearch).trim() || location.trim();
    if (!nextLocation || nextLocation === 'Set your location') {
      Alert.alert('Choose a location', 'Search for an area or use your current location first.');
      return;
    }
    const finalAddressLabel = addressLabelType === 'Other' ? customAddressLabel.trim() : addressLabelType;
    if (!finalAddressLabel) {
      Alert.alert('Add address label', 'Choose Home or Office, or enter a custom name for Other.');
      return;
    }

    setLocation(nextLocation);
    setLocationSearch(nextLocation);

    if (buyerProfile) {
      try {
        const fullAddress = locationAddress.trim() || nextLocation;
        const updatedProfile = await buyerApi<BuyerProfile>('/users/me', {
          method: 'PUT',
          body: JSON.stringify({
            location: fullAddress,
            city: nextLocation,
            lat: userCoords?.lat ?? null,
            lng: userCoords?.lng ?? null,
          }),
        });
        setBuyerProfile(updatedProfile);
        const createdAddress = await buyerApi<BuyerAddress>('/users/me/addresses', {
          method: 'POST',
          body: JSON.stringify({
            label: finalAddressLabel,
            address: fullAddress,
            lat: userCoords?.lat,
            lng: userCoords?.lng,
          }),
        });
        setSavedAddresses((current) => {
          const deduped = current.filter((item) => item.id !== createdAddress.id && item.label !== createdAddress.label);
          return [createdAddress, ...deduped];
        });
        setSavedAddressesReady(true);
      } catch {
        // Keep local state even if profile sync fails.
      }
    }

    setShowLocationModal(false);
  };

  const togglePref = (id: string) => {
    setPrefs((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  };

  const handleSelectFood = (id: string) => {
    setSelectedFood(id);
    const names: Record<string, string> = {
      '1': 'Chicken Curry',
      '2': 'Mutton Curry',
      '3': 'Chicken Biryani',
      '4': 'Veg Thali',
      '5': 'Paneer Butter Masala',
      '6': 'Dal Makhani',
      '7': 'Fish Curry',
      '8': 'Veg Cutlet',
      '9': 'Tandoori Roti',
      '10': 'Hakka Noodles',
      '11': 'Chocolate Cake',
    };
    if (id !== '12' && names[id]) setDishName(names[id]);
  };

  const normalizedDishQuery = dishName.trim().toLowerCase();
  const filteredDishSuggestions = normalizedDishQuery
    ? dishNameSuggestions
      .filter((item) => item.toLowerCase().includes(normalizedDishQuery) && item.toLowerCase() !== normalizedDishQuery)
      .sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(normalizedDishQuery);
        const bStarts = b.toLowerCase().startsWith(normalizedDishQuery);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return a.localeCompare(b);
      })
      .slice(0, 6)
    : [];
  const quantityGuide = FOOD_PORTION_GUIDE[selectedFood] ?? FOOD_PORTION_GUIDE['12'];
  const isThali = selectedFood === '4';
  const estimatedServings = qtyGrams <= 0 ? 0 : Math.max(1, Math.round(qtyGrams / quantityGuide.gramsPerPerson));
  const quantityDisplayLabel = qtyGrams >= 1000
    ? `${(qtyGrams / 1000).toFixed(qtyGrams % 1000 === 0 ? 0 : 1)} kg`
    : `${qtyGrams} g`;
  const servingSummaryLabel = isThali
    ? `${thaliPlates} ${thaliPlates === 1 ? 'plate' : 'plates'}`
    : estimatedServings === 0
      ? 'Add quantity to see servings'
      : `Serves approx ${estimatedServings} ${estimatedServings === 1 ? 'person' : 'people'}`;
  const collapsedPrefs = PREFS.slice(0, 5);
  const visiblePrefs = showAllPrefs ? PREFS : collapsedPrefs;
  const selectedSides = SIDE_OPTIONS
    .map((item) => ({ ...item, qty: sideQty[item.id] ?? 0 }))
    .filter((item) => item.qty > 0)
    .map(({ id, label, unit, qty }) => ({ id, label, unit, qty }));
  const requestQuoteCards: BuyerQuoteCardItem[] = (currentRequest?.quotes ?? [])
    .filter((quote) => quote.status === 'PENDING' || quote.status === 'COUNTERED')
    .sort((a, b) => (a.counterOffer ?? a.price) - (b.counterOffer ?? b.price))
    .map((quote, index, arr) => mapBuyerQuoteCard(currentRequest!, quote, index, arr.length));

  const requestNotificationCards: BuyerNotificationCard[] = myRequests
    .filter((request) => !['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(request.status))
    .map((request) => {
      const latestQuote = getLatestBuyerRequestQuote(request);
      const latestQuotePrice = latestQuote ? (latestQuote.counterOffer ?? latestQuote.price) : null;
      const acceptedRequestPrice = getAcceptedBuyerRequestPrice(request);
      const orderStatus = request.order?.status ?? null;
      const paymentStatus = request.order?.paymentStatus ?? null;
      const hasChefCounter = (request.quotes ?? []).some((quote) => quote.status === 'COUNTERED');
      const isNegotiating = request.quotesCount > 0 || hasChefCounter;
      const isCooking = !!orderStatus || request.status === 'COOKING' || request.status === 'READY';
      const statusLabel = paymentStatus === 'HOLD'
        ? 'Awaiting Payment'
        : paymentStatus === 'ADVANCE_PAID'
        ? (
          orderStatus === 'OUT_FOR_DELIVERY' ? 'Out for Delivery'
            : orderStatus === 'READY' ? (request.delivery === 'pickup' ? 'Ready for Pickup' : 'Ready')
              : orderStatus === 'COOKING' ? 'Cooking Started'
                : 'Confirmed'
        )
        : orderStatus
        ? (
          orderStatus === 'OUT_FOR_DELIVERY' ? 'Out for Delivery'
            : orderStatus === 'READY' ? (request.delivery === 'pickup' ? 'Ready for Pickup' : 'Ready')
              : orderStatus === 'COOKING' ? 'Cooking Started'
                : orderStatus === 'CONFIRMED' ? 'Confirmed'
                  : orderStatus === 'DELIVERED' ? 'Delivered'
                    : 'Cancelled'
        )
        : isCooking
          ? request.status === 'READY' ? 'Ready' : 'Cooking'
        : hasChefCounter
          ? 'Chef Countered'
        : isNegotiating
          ? 'Negotiating'
          : 'Open';
      const statusBg = isCooking ? C.paleGreen : isNegotiating ? C.paleYellow : C.paleBlue;
      const statusColor = isCooking ? C.mint : isNegotiating ? '#B07800' : '#4F6CF5';
      const quantityTag = request.category.toLowerCase().includes('thali')
        ? `${request.people} ${request.people === 1 ? 'plate' : 'plates'}`
        : request.qty >= 1
          ? `${request.qty} kg`
          : `${Math.round(request.qty * 1000)} g`;
      const quoteCount = request.quotesCount ?? 0;
      const quoteLabel = paymentStatus === 'HOLD'
        ? `pay within ${holdTimeLeft(request.order?.holdUntil) ?? '10:00'}`
        : paymentStatus === 'ADVANCE_PAID'
        ? 'advance paid · balance due'
        : orderStatus
        ? (
          orderStatus === 'OUT_FOR_DELIVERY' ? 'out for delivery'
            : orderStatus === 'READY' ? (request.delivery === 'pickup' ? 'ready for pickup' : 'ready to deliver')
              : orderStatus === 'COOKING' ? `ready in ${countdownTo(request.order?.readyAt) ?? request.quotes?.[0]?.cookTime ?? 'soon'}`
                : orderStatus === 'CONFIRMED' ? 'order confirmed'
                  : orderStatus === 'DELIVERED' ? 'delivered'
                    : 'order cancelled'
        )
        : isCooking
          ? request.status === 'READY' ? 'ready' : 'chef accepted'
        : hasChefCounter
          ? 'new counter offer waiting'
        : quoteCount === 1 ? 'quote received' : 'quotes received';

      const primaryRequestPrice = isCooking && acceptedRequestPrice != null ? acceptedRequestPrice : request.budget;
      const showOriginalBudgetAsSecondary = isCooking && acceptedRequestPrice != null && acceptedRequestPrice !== request.budget;
      const secondaryRequestPrice = showOriginalBudgetAsSecondary
        ? request.budget
        : latestQuotePrice;
      const secondaryRequestPriceLabel = showOriginalBudgetAsSecondary
        ? 'Original budget'
        : latestQuotePrice != null
          ? 'Negotiated price'
          : undefined;

      return {
        id: request.id,
        emoji: FOOD_CATEGORIES.find((item) => item.label.toLowerCase() === request.category.toLowerCase())?.emoji ?? 'ÃƒÂ°Ã…Â¸Ã‚ÂÃ‚Â½ÃƒÂ¯Ã‚Â¸Ã‚Â',
        emojiBg: paymentStatus === 'HOLD' ? C.paleYellow : (paymentStatus === 'ADVANCE_PAID' || isCooking) ? C.paleGreen : isNegotiating ? C.paleYellow : C.blush,
        name: request.dishName,
        by: `by You | ${timeAgo(request.createdAt)}`,
        status: statusLabel,
        statusBg: paymentStatus === 'HOLD' ? C.paleYellow : paymentStatus === 'ADVANCE_PAID' ? C.paleGreen : statusBg,
        statusColor: paymentStatus === 'HOLD' ? '#B07800' : paymentStatus === 'ADVANCE_PAID' ? C.mint : statusColor,
        tags: [request.spiceLevel, quantityTag, ...request.preferences.slice(0, 2)],
        price: `\u20B9${primaryRequestPrice}`,
        priceLabel: isCooking ? 'Final negotiated price' : 'Original budget',
        secondaryPrice: secondaryRequestPrice != null ? `\u20B9${secondaryRequestPrice}` : undefined,
        secondaryPriceLabel: secondaryRequestPriceLabel,
        quotesCount: paymentStatus === 'HOLD' ? 'PAY' : (paymentStatus === 'ADVANCE_PAID' || orderStatus) ? 'LIVE' : String(quoteCount),
        quotesLabel: quoteLabel,
        quotesBg: paymentStatus === 'HOLD' ? C.turmeric : orderStatus ? C.mint : isCooking ? C.mint : quoteCount > 0 ? C.spice : C.warmGray,
        target: 'request',
        rawRequest: request,
        activityAt: request.createdAt,
      };
    });

  const offerNotificationCards: BuyerNotificationCard[] = myOffers
    .filter((offer) => !['REJECTED', 'EXPIRED'].includes(offer.status) && getOfferOrderStatus(offer) !== 'DELIVERED')
    .map((offer) => {
      const originalOfferTotal = offer.offerPrice * offer.plates;
      const negotiatedOfferTotal = (offer.agreedPrice ?? offer.counterPrice ?? offer.offerPrice) * offer.plates;
      const hasNegotiatedDelta = negotiatedOfferTotal !== originalOfferTotal || offer.counterPrice != null || offer.agreedPrice != null;
      const orderStatus = getOfferOrderStatus(offer);
      const isPaid = offer.status === 'PAID' || offer.status === 'ADVANCE_PAID';
      const statusLabel =
        offer.status === 'COUNTERED'
          ? (offer.lastOfferBy === 'CHEF' ? 'Chef Countered' : 'Counter Sent')
          : offer.status === 'HOLD'
            ? 'Awaiting Payment'
            : offer.status === 'ADVANCE_PAID'
              ? getOfferOrderStatusLabel(offer)
              : isPaid
                ? getOfferOrderStatusLabel(offer)
                : 'Awaiting Chef';
      const statusBg =
        isPaid ? C.paleGreen
          : offer.status === 'HOLD' || offer.status === 'COUNTERED' ? C.paleYellow
            : C.paleBlue;
      const statusColor =
        isPaid ? C.mint
          : offer.status === 'HOLD' || offer.status === 'COUNTERED' ? '#B07800'
            : '#4F6CF5';
      const quotesLabel =
        offer.status === 'COUNTERED'
          ? (offer.lastOfferBy === 'CHEF' ? 'tap to accept, reject, or counter' : 'waiting for chef reply')
          : offer.status === 'HOLD'
            ? `pay within ${holdTimeLeft(offer.holdUntil) ?? '10:00'}`
            : offer.status === 'ADVANCE_PAID'
              ? 'advance paid · balance due'
              : isPaid
                ? (
                  orderStatus === 'OUT_FOR_DELIVERY' ? 'out for delivery'
                    : orderStatus === 'DELIVERED' ? 'delivered'
                      : 'order confirmed'
                )
                : 'waiting for chef approval';
      return {
        id: `offer-${offer.id}`,
        emoji: offer.dishEmoji,
        emojiBg: isPaid ? C.paleGreen : offer.status === 'HOLD' ? C.paleYellow : C.blush,
        name: offer.dishName,
        by: `Today board | ${timeAgo(offer.updatedAt)}`,
        status: statusLabel,
        statusBg,
        statusColor,
        tags: [
          `${offer.plates} plate${offer.plates === 1 ? '' : 's'}`,
          offer.deliveryMode === 'delivery' ? 'Home delivery' : offer.deliveryMode === 'pickup' ? 'Self pickup' : 'Delivery pending',
          ...(offer.counterNote ? [offer.counterNote] : []),
        ].slice(0, 3),
        price: `\u20B9${originalOfferTotal}`,
        priceLabel: 'Original price',
        secondaryPrice: hasNegotiatedDelta ? `\u20B9${negotiatedOfferTotal}` : undefined,
        secondaryPriceLabel: hasNegotiatedDelta ? (isPaid ? 'Negotiated total' : 'Negotiated price') : undefined,
        quotesCount: offer.status === 'HOLD' ? 'PAY' : offer.status === 'COUNTERED' ? 'NEW' : isPaid ? 'LIVE' : 'OPEN',
        quotesLabel,
        quotesBg: isPaid ? C.mint : offer.status === 'HOLD' ? C.turmeric : C.spice,
        target: 'orders',
        rawOffer: offer,
        activityAt: offer.updatedAt,
      };
    });

  const notificationCards: BuyerNotificationCard[] = [...requestNotificationCards, ...offerNotificationCards]
    .sort((a, b) => new Date(b.activityAt).getTime() - new Date(a.activityAt).getTime());
  const currentNotificationKeys = notificationCards.map(getNotificationVersionKey);
  const unseenNotificationCount = seenNotificationsReady
    ? notificationCards.filter((item) => !seenNotificationKeys.includes(getNotificationVersionKey(item))).length
    : 0;

  useEffect(() => {
    if (!seenNotificationsReady) return;
    setSeenNotificationKeys((current) => {
      const next = current.filter((key) => currentNotificationKeys.includes(key));
      return next.length === current.length && next.every((key, index) => key === current[index]) ? current : next;
    });
  }, [currentNotificationKeys, seenNotificationsReady]);

  const markNotificationSeen = (item: BuyerNotificationCard) => {
    const key = getNotificationVersionKey(item);
    setSeenNotificationKeys((current) => (current.includes(key) ? current : [...current, key]));
  };

  const goHome = () => setScreen('home');
  const goExplore = () => setScreen('explore');
  const goRequest = () => {
    setScreen('post-request');
  };
  const goQuotes = () => {
    setQuotesBudget(budget);
    setScreen('quotes');
  };
  const goOrders = () => setScreen('orders');
  const goProfile = () => setScreen('profile');
  const openNotificationCard = async (item: BuyerNotificationCard) => {
    markNotificationSeen(item);
    if (item.rawRequest) {
      try {
        const fullRequest = buyerProfile
          ? await buyerApi<BuyerRequestApi>(`/requests/${item.rawRequest.id}`)
          : await fetch(`${API_BASE}/requests/${item.rawRequest.id}`).then(async (res) => {
            const data = await res.json();
            if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not load request details');
            return data as BuyerRequestApi;
          });
        setSelectedNotification({ ...item, rawRequest: fullRequest });
        return;
      } catch {
        setSelectedNotification(item);
        return;
      }
    }
    setSelectedNotification(item);
  };
  const openLiveRequest = async (request: BuyerRequestApi) => {
    setCurrentRequestId(request.id);
    setCurrentRequest(request);
    await loadCurrentRequest(request.id);
    setQuotesBudget(request.budget);
    setScreen('quotes');
  };
  const handleRaiseBudget = () => setQuotesBudget((current) => current + 50);
  const handleSendCounter = async (offer: number) => {
    if (!counterChef) return;
    try {
      let updatedQuote: BuyerRequestQuoteApi | null = null;
      if (buyerProfile) {
        updatedQuote = await buyerApi<BuyerRequestQuoteApi>(`/quotes/${counterChef.rawQuote.id}/counter`, {
          method: 'POST',
          body: JSON.stringify({ offer }),
        });
      } else {
        if (!buyerToken) return;
        const res = await fetch(`${API_BASE}/quotes/${counterChef.rawQuote.id}/public-counter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ buyerToken, offer }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not send counter offer');
        updatedQuote = data as BuyerRequestQuoteApi;
      }
      if (updatedQuote) {
        setCurrentRequest((current) => current ? ({
          ...current,
          quotes: (current.quotes ?? []).map((quote) => quote.id === updatedQuote!.id ? { ...quote, ...updatedQuote! } : quote),
        }) : current);
      }
      setQuotesBudget(offer);
      setCounterChef(null);
      if (currentRequestId) await loadCurrentRequest(currentRequestId);
      Alert.alert('Counter sent', 'The chef will see your updated offer.');
    } catch (error) {
      Alert.alert('Counter failed', error instanceof Error ? error.message : 'Could not send counter offer.');
    }
  };

  const goFloated = async () => {
    if (!buyerToken) {
      Alert.alert('Please wait', 'Buyer identity is still loading. Try again in a moment.');
      return;
    }

    const categoryLabel = FOOD_CATEGORIES.find((item) => item.id === selectedFood)?.label ?? 'Custom';
    const quantityLabel = isThali ? `${thaliPlates} ${thaliPlates === 1 ? 'plate' : 'plates'}` : quantityDisplayLabel;
    let uploadedBuildingImageUrl: string | null = null;
    if (delivery === 'delivery') {
      try {
        uploadedBuildingImageUrl = await uploadBuildingImageIfNeeded();
      } catch {
        Alert.alert('Image upload failed', 'Building photo could not be uploaded. The request will continue without it.');
      }
    }

    const noteParts = [
      `Quantity: ${quantityLabel}`,
      isThali ? `Thali includes: ${THALI_INCLUDES}` : `Serving guide: ${quantityGuide.helper}`,
      selectedSides.length ? `Sides: ${selectedSides.map((item) => `${item.label} ${item.qty} ${item.unit}`).join(', ')}` : '',
      delivery === 'delivery' && locationAddress.trim() ? `Delivery address: ${locationAddress.trim()}` : '',
      delivery === 'delivery' && locationLandmark.trim() ? `Landmark: ${locationLandmark.trim()}` : '',
      delivery === 'delivery' && uploadedBuildingImageUrl ? `Building photo: ${uploadedBuildingImageUrl}` : '',
      remarks.trim() ? `Remarks: ${remarks.trim()}` : '',
    ].filter(Boolean);

    const nextFloatedDish: FloatedDish = {
      dishName,
      emoji: FOOD_CATEGORIES.find((item) => item.id === selectedFood)?.emoji,
      qtyGrams,
      servings: isThali ? thaliPlates : estimatedServings,
      quantityLabel,
      servingNote: isThali ? THALI_INCLUDES : quantityGuide.helper,
      spiceLevel: spice,
      delivery,
      budget,
      remarks: remarks.trim() || undefined,
      sides: selectedSides.length ? selectedSides : undefined,
      geoRadius,
      ...userCoords ?? {},
    };

    const effectiveLocation = location.trim();
    if (!effectiveLocation || effectiveLocation === 'Set your location' || !userCoords) {
      Alert.alert('Set your location', 'To send a request to all nearby chefs, first choose your exact location from the location picker.');
      return;
    }

    setPostingRequest(true);
    try {
      const createdRequest = await buyerApi<BuyerRequestApi>('/requests', {
        method: 'POST',
        body: JSON.stringify({
          category: categoryLabel,
          dishName,
          qty: isThali ? thaliPlates : Math.max(0.1, qtyGrams / 1000),
          people: Math.max(1, isThali ? thaliPlates : estimatedServings),
          spiceLevel: spice,
          preferences: prefs,
          delivery,
          budget,
          notes: joinNoteParts(noteParts),
          lat: userCoords?.lat,
          lng: userCoords?.lng,
          city: effectiveLocation,
          notifyRadiusKm: geoRadius,
          buyerToken,
          buyerName: buyerDisplayName,
        }),
      });
      setFloatedDish(nextFloatedDish);
      setCurrentRequestId(createdRequest.id);
      setCurrentRequest({ ...createdRequest, quotesCount: 0, quotes: [] });
      await loadMyRequests();
      setQuotesBudget(budget);
      setScreen('request-floated');
    } catch (error) {
      Alert.alert('Request failed', error instanceof Error ? error.message : 'Could not raise your request.');
    } finally {
      setPostingRequest(false);
    }
  };
  const updateSideQty = (id: string, nextQty: number) => {
    setSideQty((current) => {
      if (nextQty <= 0) {
        const { [id]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [id]: nextQty };
    });
  };
  const goChefProfile = () => setScreen('chef-profile');
  const [viewingChef, setViewingChef] = useState<PublicChef | null>(null);
  const goPublicChef = (chef: PublicChef) => { setViewingChef(chef); setScreen('public-chef'); };
  const isChefSaved = (chefId: string) => savedChefs.some((item) => item.id === chefId);
  const toggleSavedChef = (chef: PublicChef, city?: string | null) => {
    setSavedChefs((current) => {
      const existing = current.some((item) => item.id === chef.id);
      if (existing) return current.filter((item) => item.id !== chef.id);
      const nextChef: SavedChef = {
        ...chef,
        city: city ?? null,
        savedAt: new Date().toISOString(),
      };
      return [nextChef, ...current].slice(0, 20);
    });
  };

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Buyer device token (loaded once on mount) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const [buyerToken, setBuyerToken] = useState<string | null>(null);
  useEffect(() => { getBuyerToken().then(setBuyerToken); }, []);
  useEffect(() => {
    (async () => {
      await getBuyerToken();
      const access = await BuyerTokens.getAccess();
      if (!access) {
        setBooting(false);
        setScreen('auth');
        return;
      }
      try {
        const profile = await buyerApi<BuyerProfile>('/users/me');
        setBuyerProfile(profile);
        setScreen('home');
      } catch {
        await BuyerTokens.clear();
        setBuyerProfile(null);
        setScreen('auth');
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const handleBuyerAuthSuccess = async (payload: BuyerAuthResponse) => {
    await BuyerTokens.set(payload.accessToken, payload.refreshToken);
    const profile = await buyerApi<BuyerProfile>('/users/me').catch(() => payload.user);
    setBuyerProfile(profile);
    setScreen('home');
  };

  const handleBuyerLogout = async () => {
    const refreshToken = await BuyerTokens.getRefresh();
    if (refreshToken) {
      try {
        await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // ignore logout failures
      }
    }
    await BuyerTokens.clear();
    setBuyerProfile(null);
    setScreen('auth');
  };

  const submitBuyerAuth = async () => {
    const phone = authPhone.trim();
    const password = authPassword.trim();
    const name = authName.trim();
    if (!phone || !password || (authMode === 'register' && !name)) {
      Alert.alert('Missing details', authMode === 'register' ? 'Enter your name, phone number, and password.' : 'Enter your phone number and password.');
      return;
    }

    setAuthBusy(true);
    try {
      const path = authMode === 'register' ? '/auth/register' : '/auth/login';
      const payload = authMode === 'register'
        ? {
            name,
            phone,
            password,
            role: 'BUYER',
            city: location,
            lat: userCoords?.lat,
            lng: userCoords?.lng,
          }
        : {
            phone,
            password,
          };

      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Authentication failed');

      await handleBuyerAuthSuccess(data as BuyerAuthResponse);
      setAuthPassword('');
      if (authMode === 'register') setAuthMode('login');
    } catch (error) {
      Alert.alert(authMode === 'register' ? 'Sign up failed' : 'Login failed', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setAuthBusy(false);
    }
  };

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ My negotiations (buyer's own offers, polled periodically) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const sendOtp = async () => {
    const email = authEmail.trim().toLowerCase();
    if (!email) { Alert.alert('Enter email', 'Please enter your email address.'); return; }
    setOtpBusy(true);
    try {
      const res = await fetch(`${API_BASE}/auth/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json() as { sent?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to send code');
      setAuthStep('otp');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setOtpBusy(false);
    }
  };

  const verifyOtp = async () => {
    const email = authEmail.trim().toLowerCase();
    const otp = authOtp.trim();
    if (otp.length !== 6) { Alert.alert('Enter code', 'Enter the 6-digit code from your email.'); return; }
    setOtpBusy(true);
    try {
      const res = await fetch(`${API_BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
      const data = await res.json() as { isNewUser?: boolean; user?: BuyerProfile; accessToken?: string; refreshToken?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Verification failed');
      if (data.isNewUser) {
        setAuthStep('register');
      } else {
        await handleBuyerAuthSuccess({ user: data.user!, accessToken: data.accessToken!, refreshToken: data.refreshToken! });
      }
    } catch (err) {
      Alert.alert('Invalid code', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setOtpBusy(false);
    }
  };

  const detectAuthLocation = async () => {
    setAuthGpsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission denied', 'Allow location to auto-fill your area.'); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;
      setAuthGpsCoords({ lat: latitude, lng: longitude });
      const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
      if (place) {
        const cityName = place.city || place.subregion || place.region || '';
        setAuthAddrCity(cityName);
        setAuthAddrPincode(place.postalCode ?? '');
        setAuthAddrStreet(place.street ?? '');
        setAuthGpsLabel([place.city || place.subregion, place.region].filter(Boolean).join(', '));
      }
    } catch {
      Alert.alert('Error', 'Could not detect location. Please fill in manually.');
    } finally {
      setAuthGpsLocating(false);
    }
  };

  const completeOtpRegistration = async () => {
    const firstName = authFirstName.trim();
    const lastName = authLastName.trim();
    const phone = authRegPhone.trim();
    if (!firstName || !lastName) { Alert.alert('Name required', 'Please enter your first and last name.'); return; }
    if (!/^\d{10}$/.test(phone)) { Alert.alert('Invalid phone', 'Phone number must be exactly 10 digits.'); return; }
    setOtpBusy(true);
    try {
      const res = await fetch(`${API_BASE}/auth/register-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: authEmail.trim().toLowerCase(),
          firstName,
          lastName,
          phone,
          lat: authGpsCoords?.lat,
          lng: authGpsCoords?.lng,
          city: authAddrCity.trim() || undefined,
          houseNo: authAddrHouse.trim() || undefined,
          street: authAddrStreet.trim() || undefined,
          pincode: authAddrPincode.trim() || undefined,
        }),
      });
      const data = await res.json() as BuyerAuthResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Registration failed');
      await handleBuyerAuthSuccess(data);
    } catch (err) {
      Alert.alert('Registration failed', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setOtpBusy(false);
    }
  };

  const [respondOffer, setRespondOffer] = useState<DishOfferItem | null>(null);
  const [respondPrice, setRespondPrice] = useState('');
  const [respondBusy, setRespondBusy] = useState(false);
  const [checkoutOffer, setCheckoutOffer] = useState<DishOfferItem | null>(null);
  const [checkoutRequestOrder, setCheckoutRequestOrder] = useState<BuyerRequestOrderItem | null>(null);
  const [checkoutDelivery, setCheckoutDelivery] = useState<'pickup' | 'delivery'>('pickup');
  const [checkoutPaymentType, setCheckoutPaymentType] = useState<'full' | 'advance'>('full');
  const [bringOwnContainer, setBringOwnContainer] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reviewState, setReviewState] = useState<ReviewPromptState>({});
  const [reviewStateReady, setReviewStateReady] = useState(false);
  const [reviewPromptOffer, setReviewPromptOffer] = useState<DishOfferItem | null>(null);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [selectedNotification, setSelectedNotification] = useState<BuyerNotificationCard | null>(null);
  const [savedChefs, setSavedChefs] = useState<SavedChef[]>([]);
  const [savedChefsReady, setSavedChefsReady] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(REVIEW_STORE_KEY)
      .then((raw) => setReviewState(raw ? JSON.parse(raw) as ReviewPromptState : {}))
      .catch(() => undefined)
      .finally(() => setReviewStateReady(true));
  }, []);

  useEffect(() => {
    if (!buyerProfile?.id) {
      setSeenNotificationKeys([]);
      setSeenNotificationsReady(true);
      return;
    }
    const storageKey = `${SEEN_NOTIFICATIONS_STORE_KEY}_${buyerProfile.id}`;
    setSeenNotificationsReady(false);
    SecureStore.getItemAsync(storageKey)
      .then((raw) => setSeenNotificationKeys(raw ? JSON.parse(raw) as string[] : []))
      .catch(() => setSeenNotificationKeys([]))
      .finally(() => setSeenNotificationsReady(true));
  }, [buyerProfile?.id]);

  useEffect(() => {
    if (!buyerProfile?.id) {
      setSavedChefs([]);
      setSavedChefsReady(true);
      return;
    }
    const storageKey = `${SAVED_CHEFS_STORE_KEY}_${buyerProfile.id}`;
    setSavedChefsReady(false);
    SecureStore.getItemAsync(storageKey)
      .then((raw) => setSavedChefs(raw ? JSON.parse(raw) as SavedChef[] : []))
      .catch(() => setSavedChefs([]))
      .finally(() => setSavedChefsReady(true));
  }, [buyerProfile?.id]);

  useEffect(() => {
    if (!buyerProfile?.id || !seenNotificationsReady) return;
    SecureStore.setItemAsync(`${SEEN_NOTIFICATIONS_STORE_KEY}_${buyerProfile.id}`, JSON.stringify(seenNotificationKeys)).catch(() => undefined);
  }, [buyerProfile?.id, seenNotificationKeys, seenNotificationsReady]);

  useEffect(() => {
    if (!buyerProfile?.id || !savedChefsReady) return;
    SecureStore.setItemAsync(`${SAVED_CHEFS_STORE_KEY}_${buyerProfile.id}`, JSON.stringify(savedChefs)).catch(() => undefined);
  }, [buyerProfile?.id, savedChefs, savedChefsReady]);

  useEffect(() => {
    if (!selectedNotification?.rawRequest?.id) return;
    if (selectedNotification.rawRequest.quotes && selectedNotification.rawRequest.quotes.length > 0) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/requests/${selectedNotification.rawRequest!.id}`);
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setSelectedNotification((current) => {
          if (!current || current.rawRequest?.id !== selectedNotification.rawRequest!.id) return current;
          return { ...current, rawRequest: data as BuyerRequestApi };
        });
      } catch {
        // keep existing lightweight notification payload
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedNotification?.rawRequest?.id, selectedNotification?.rawRequest?.quotes?.length]);

  const loadMyOffers = async (token: string) => {
    try {
      const res = await fetch(`${API_BASE}/offers/buyer?token=${encodeURIComponent(token)}`);
      if (res.ok) {
        const data: DishOfferItem[] = await res.json();
        setMyOffers((prev) => {
          const prevCountered = prev.filter((o) => o.status === 'COUNTERED').map((o) => o.id).sort().join(',');
          const nextCountered = data.filter((o) => o.status === 'COUNTERED').map((o) => o.id).sort().join(',');
          if (nextCountered !== prevCountered) setNegSheetDismissed(false);
          return data;
        });
      }
    } catch { /* ignore */ }
  };

  const loadMyRequests = async () => {
    try {
      const data = await buyerApi<BuyerRequestApi[]>('/requests/me?limit=30');
      setMyRequests(data);
    } catch {
      setMyRequests([]);
    }
  };

  const loadMyRequestOrders = async () => {
    try {
      const data = await buyerApi<BuyerRequestOrderItem[]>('/orders?role=buyer');
      setMyRequestOrders(data);
    } catch {
      setMyRequestOrders([]);
    }
  };

  useEffect(() => {
    if (!buyerToken) return;
    loadMyOffers(buyerToken);
    const id = setInterval(() => loadMyOffers(buyerToken), 15000);
    return () => clearInterval(id);
  }, [buyerToken]);

  useEffect(() => {
    if (!buyerProfile) return;
    loadMyRequests();
    loadMyRequestOrders();
    const id = setInterval(() => {
      loadMyRequests();
      loadMyRequestOrders();
    }, 15000);
    return () => clearInterval(id);
  }, [buyerProfile]);

  useEffect(() => {
    if (!currentRequestId) return;
    loadCurrentRequest(currentRequestId);
    const id = setInterval(() => loadCurrentRequest(currentRequestId), 15000);
    return () => clearInterval(id);
  }, [currentRequestId]);

  const holdOrders = myOffers.filter((offer) => offer.status === 'HOLD');
  const pendingApprovalOrders = myOffers.filter((offer) => offer.status === 'PENDING');
  const placedOrders = myOffers.filter((offer) => (offer.status === 'PAID' || offer.status === 'ADVANCE_PAID') && getOfferOrderStatus(offer) !== 'DELIVERED');
  const deliveredOrders = myOffers.filter((offer) => offer.status === 'PAID' && getOfferOrderStatus(offer) === 'DELIVERED');
  const requestHoldOrders = myRequestOrders.filter((order) => order.paymentStatus === 'HOLD');
  const requestPlacedOrders = myRequestOrders.filter((order) => (order.paymentStatus === 'PAID' || order.paymentStatus === 'ADVANCE_PAID') && order.status !== 'DELIVERED' && order.status !== 'CANCELLED');
  const requestDeliveredOrders = myRequestOrders.filter((order) => order.paymentStatus === 'PAID' && order.status === 'DELIVERED');
  const recentOrders = [
    ...deliveredOrders.map((offer) => ({
      id: `offer-${offer.id}`,
      emoji: offer.dishEmoji,
      emojiBg: C.blush,
      name: offer.dishName,
      chef: offer.chefName ?? 'Chef',
      date: new Date(offer.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      price: `Rs ${(offer.agreedPrice ?? offer.offerPrice) * offer.plates}`,
      status: 'Delivered',
      statusColor: C.mint,
      rated: !!reviewState[offer.id]?.submittedAt,
      rating: reviewState[offer.id]?.rating ?? 0,
    })),
    ...requestDeliveredOrders.map((order) => ({
      id: `request-${order.id}`,
      emoji: FOOD_CATEGORIES.find((item) => item.label.toLowerCase() === order.request.category.toLowerCase())?.emoji ?? '🍲',
      emojiBg: C.paleGreen,
      name: order.request.dishName,
      chef: order.chef?.name ?? 'Chef',
      date: new Date(order.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      price: `Rs ${order.finalPrice}`,
      status: 'Delivered',
      statusColor: C.mint,
      rated: false,
      rating: 0,
    })),
  ]
    .sort((a, b) => {
      const aTime = a.id.startsWith('offer-')
        ? new Date(deliveredOrders.find((item) => `offer-${item.id}` === a.id)?.updatedAt ?? 0).getTime()
        : new Date(requestDeliveredOrders.find((item) => `request-${item.id}` === a.id)?.updatedAt ?? 0).getTime();
      const bTime = b.id.startsWith('offer-')
        ? new Date(deliveredOrders.find((item) => `offer-${item.id}` === b.id)?.updatedAt ?? 0).getTime()
        : new Date(requestDeliveredOrders.find((item) => `request-${item.id}` === b.id)?.updatedAt ?? 0).getTime();
      return bTime - aTime;
    })
    .slice(0, 10);
  const savedChefCount = savedChefs.length;
  const savedAddressCount = savedAddresses.length;
  const profileMenuGroups = MENU_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) => item.label === 'Saved Chefs'
      ? { ...item, sub: savedChefCount > 0 ? `${savedChefCount} favourite chef${savedChefCount > 1 ? 's' : ''}` : 'No saved chefs yet' }
      : item.label === 'Saved Addresses'
        ? { ...item, sub: savedAddressCount > 0 ? `${savedAddressCount} saved address${savedAddressCount > 1 ? 'es' : ''}` : 'No saved addresses yet' }
        : item),
  }));
  const buyerOrderSections = [
    {
      key: 'payment',
      title: 'Awaiting Payment',
      emoji: '💳',
      count: holdOrders.length + requestHoldOrders.length,
      badgeBg: C.spice,
      sortPriority: 0,
    },
    {
      key: 'approval',
      title: 'Awaiting Chef Approval',
      emoji: '⏳',
      count: pendingApprovalOrders.length,
      badgeBg: C.turmeric,
      sortPriority: 1,
    },
    {
      key: 'confirmed',
      title: 'Confirmed Orders',
      emoji: '📦',
      count: placedOrders.length + requestPlacedOrders.length,
      badgeBg: C.mint,
      sortPriority: 2,
    },
  ].sort((a, b) => {
    const aActive = a.count > 0 ? 0 : 1;
    const bActive = b.count > 0 ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.sortPriority - b.sortPriority;
  });

  const persistReviewState = async (next: ReviewPromptState) => {
    setReviewState(next);
    try {
      await SecureStore.setItemAsync(REVIEW_STORE_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!reviewStateReady) return;
    const now = Date.now();
    const nextOffer = deliveredOrders.find((offer) => {
      const deliveredAt = new Date(offer.updatedAt).getTime();
      if (!Number.isFinite(deliveredAt) || now - deliveredAt < REVIEW_PROMPT_DELAY_MS) return false;
      const state = reviewState[offer.id];
      if (state?.submittedAt) return false;
      if (state?.snoozeUntil && new Date(state.snoozeUntil).getTime() > now) return false;
      return true;
    }) ?? null;

    if (!nextOffer) {
      setReviewPromptOffer(null);
      return;
    }

    setReviewPromptOffer((current) => current?.id === nextOffer.id ? current : nextOffer);
    const saved = reviewState[nextOffer.id];
    setReviewRating(saved?.rating ?? 0);
    setReviewComment(saved?.comment ?? '');
  }, [deliveredOrders, reviewState, reviewStateReady]);

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Home bargain modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  type HomeBargainItem = { dishId: string; chefId: string; name: string; emoji: string; chefPrice: number; maxPlates: number };
  const [homeBargainItem, setHomeBargainItem] = useState<HomeBargainItem | null>(null);
  const [homeBargainOffer, setHomeBargainOffer] = useState('');
  const [homeBargainPlates, setHomeBargainPlates] = useState(1);
  const [homeBargainSending, setHomeBargainSending] = useState(false);
  const [homeBargainSent, setHomeBargainSent] = useState<Record<string, number>>({});

  const openHomeBargain = (item: HomeBargainItem) => {
    setHomeBargainOffer(String(Math.round(item.chefPrice * 0.9)));
    setHomeBargainPlates(1);
    setHomeBargainItem(item);
  };

  const sendHomeOffer = async () => {
    if (!homeBargainItem || !buyerToken) return;
    const offer = parseInt(homeBargainOffer, 10);
    if (!offer || offer <= 0) return;
    setHomeBargainSending(true);
    try {
      await fetch(`${API_BASE}/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dishId: homeBargainItem.dishId,
          chefId: homeBargainItem.chefId,
          buyerName: buyerDisplayName,
          buyerToken,
          plates: homeBargainPlates,
          offerPrice: offer,
        }),
      });
      setHomeBargainSent((prev) => ({ ...prev, [homeBargainItem.name]: offer }));
      if (buyerToken) loadMyOffers(buyerToken);
    } catch {
      setHomeBargainSent((prev) => ({ ...prev, [homeBargainItem.name]: offer }));
    } finally {
      setHomeBargainSending(false);
      setHomeBargainItem(null);
    }
  };

  const payForOffer = async () => {
    if (!checkoutOffer || !buyerToken) return;
    setCheckoutBusy(true);
    try {
      const res = await fetch(`${API_BASE}/offers/${checkoutOffer.id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerToken,
          deliveryMode: checkoutDelivery,
          paymentMethod: 'demo',
          paymentType: checkoutPaymentType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Payment failed');
      setCheckoutOffer(null);
      setCheckoutPaymentType('full');
      await loadMyOffers(buyerToken);
      const msg = checkoutPaymentType === 'advance'
        ? 'Your order is confirmed with 20% advance. Pay the balance before delivery.'
        : 'Your order is confirmed and the chef has been notified.';
      Alert.alert('Payment successful', msg);
    } catch (error) {
      Alert.alert('Payment failed', error instanceof Error ? error.message : 'Could not complete demo payment.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const payForRequestOrder = async () => {
    if (!checkoutRequestOrder) return;
    setCheckoutBusy(true);
    try {
      await buyerApi<BuyerRequestOrderItem>(`/orders/${checkoutRequestOrder.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ paymentMethod: 'demo', paymentType: checkoutPaymentType }),
      });
      setCheckoutRequestOrder(null);
      setCheckoutPaymentType('full');
      await loadMyRequestOrders();
      await loadMyRequests();
      const msg = checkoutPaymentType === 'advance'
        ? 'Your order is confirmed with 20% advance. Pay the balance before delivery.'
        : 'Your request order is confirmed and the chef has been notified.';
      Alert.alert('Payment successful', msg);
    } catch (error) {
      Alert.alert('Payment failed', error instanceof Error ? error.message : 'Could not complete demo payment.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const payBalanceForOffer = async (offer: DishOfferItem) => {
    if (!buyerToken) return;
    try {
      const res = await fetch(`${API_BASE}/offers/${offer.id}/pay-balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buyerToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Payment failed');
      await loadMyOffers(buyerToken);
      Alert.alert('Balance paid', 'Your remaining balance has been paid. Thank you!');
    } catch (error) {
      Alert.alert('Payment failed', error instanceof Error ? error.message : 'Could not complete balance payment.');
    }
  };

  const payBalanceForRequestOrder = async (order: BuyerRequestOrderItem) => {
    try {
      await buyerApi<BuyerRequestOrderItem>(`/orders/${order.id}/pay-balance`, { method: 'POST', body: JSON.stringify({}) });
      await loadMyRequestOrders();
      Alert.alert('Balance paid', 'Your remaining balance has been paid. Thank you!');
    } catch (error) {
      Alert.alert('Payment failed', error instanceof Error ? error.message : 'Could not complete balance payment.');
    }
  };

  const refreshBuyerData = async () => {
    setRefreshing(true);
    try {
      await loadCookingFeed();
      if (buyerToken) {
        await loadMyOffers(buyerToken);
      }
      if (buyerProfile) {
        await loadMyRequests();
        await loadMyRequestOrders();
      }
      if (currentRequestId) {
        await loadCurrentRequest(currentRequestId);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const snoozeReviewPrompt = async () => {
    if (!reviewPromptOffer) return;
    const snoozeUntil = new Date(Date.now() + REVIEW_SNOOZE_MS).toISOString();
    const next = { ...reviewState };
    deliveredOrders.forEach((offer) => {
      if (reviewState[offer.id]?.submittedAt) return;
      next[offer.id] = {
        ...reviewState[offer.id],
        rating: offer.id === reviewPromptOffer.id ? (reviewRating || undefined) : reviewState[offer.id]?.rating,
        comment: offer.id === reviewPromptOffer.id ? (reviewComment.trim() || undefined) : reviewState[offer.id]?.comment,
        snoozeUntil,
      };
    });
    await persistReviewState(next);
    setReviewPromptOffer(null);
  };

  const submitReviewPrompt = async () => {
    if (!reviewPromptOffer || !buyerToken) return;
    const comment = reviewComment.trim();
    if (reviewRating === 0 && !comment) {
      Alert.alert('Add feedback', 'You can submit a rating, a short review, or both.');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/offers/${reviewPromptOffer.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerToken,
          rating: reviewRating || undefined,
          comment: comment || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not submit review');
    } catch (error) {
      Alert.alert('Review failed', error instanceof Error ? error.message : 'Could not submit review.');
      return;
    }
    const next = {
      ...reviewState,
      [reviewPromptOffer.id]: {
        rating: reviewRating || undefined,
        comment: comment || undefined,
        submittedAt: new Date().toISOString(),
      },
    };
    await persistReviewState(next);
    setReviewPromptOffer(null);
    setReviewRating(0);
    setReviewComment('');
    Alert.alert('Thank you', 'Your review helps us maintain quality and keep the best chefs visible.');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
      {booting ? (
        <View style={authSt.bootWrap}>
          <View style={authSt.bootBadge}>
            <Text style={authSt.bootBadgeText}>NeighbourBites</Text>
          </View>
          <Text style={authSt.bootTitle}>Checking your buyer session</Text>
          <Text style={authSt.bootSub}>Loading account access and nearby cravings.</Text>
        </View>
      ) : null}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Location Picker Modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      
      <Modal visible={showLocationModal} animationType="slide" transparent onRequestClose={() => setShowLocationModal(false)}>
        <TouchableOpacity style={locSt.backdrop} activeOpacity={1} onPress={() => setShowLocationModal(false)} />
        <KeyboardAvoidingView
          style={locSt.modalWrap}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        >
        <View style={locSt.sheet}>
          <View style={locSt.handle} />
          <Text style={locSt.title}>Choose your location</Text>
          <ScrollView style={locSt.list} keyboardShouldPersistTaps="handled" contentContainerStyle={locSt.content}>
            <View style={locSt.searchRow}>
              <Text style={locSt.searchIcon}>{'\uD83D\uDD0D'}</Text>
              <TextInput
                style={locSt.searchInput}
                placeholder="Search city or area..."
                placeholderTextColor={C.warmGray}
                value={locationSearch}
                onChangeText={setLocationSearch}
                autoFocus
              />
              {locationSearch.length > 0 && (
                <TouchableOpacity onPress={() => setLocationSearch('')}>
                  <Text style={locSt.clearBtn}>{'\u274C'}</Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity style={locSt.gpsBtn} activeOpacity={0.8} onPress={useCurrentLocation} disabled={locating}>
              <Text style={locSt.gpsIcon}>{locating ? '...' : '\uD83D\uDCCD'}</Text>
              <View>
                <Text style={locSt.gpsBtnText}>{locating ? 'Detecting location...' : 'Use my current location'}</Text>
                <Text style={locSt.gpsBtnSub}>Auto-detect via GPS and drop a pin on the map</Text>
              </View>
            </TouchableOpacity>

            <View style={locSt.radiusBox}>
              <View style={locSt.radiusRow}>
                <Text style={locSt.radiusLabel}>Chef search radius</Text>
                <Text style={locSt.radiusValue}>{geoRadius} km</Text>
              </View>
              <Slider
                style={locSt.slider}
                minimumValue={1}
                maximumValue={20}
                step={1}
                value={geoRadius}
                onValueChange={(v) => setGeoRadius(Math.round(v))}
                minimumTrackTintColor={C.mint}
                maximumTrackTintColor={C.border}
                thumbTintColor={C.mint}
              />
              <View style={locSt.radiusTicks}>
                <Text style={locSt.radiusTick}>1 km</Text>
                <Text style={locSt.radiusTick}>5 km</Text>
                <Text style={locSt.radiusTick}>10 km</Text>
                <Text style={locSt.radiusTick}>20 km</Text>
              </View>
              {!userCoords && (
                <Text style={locSt.radiusHint}>Use GPS location above to enable geofencing</Text>
              )}
            </View>

            {userCoords ? (
              <View style={locSt.mapCard}>
                <View style={locSt.mapCaption}>
                  <Text style={locSt.mapCaptionTitle}>Selected location</Text>
                  <Text style={locSt.mapCaptionSub}>{userCoords.lat.toFixed(5)}, {userCoords.lng.toFixed(5)}</Text>
                </View>
              </View>
            ) : null}

            <View style={locSt.addressCard}>
              <Text style={locSt.sectionTitle}>Delivery address</Text>
              <View style={locSt.addressLabelRow}>
                {[
                  { key: 'Home' as const, label: '⌂ Home' },
                  { key: 'Office' as const, label: '▣ Office' },
                  { key: 'Other' as const, label: '✎ Other' },
                ].map((item) => (
                  <Chip
                    key={item.key}
                    label={item.label}
                    selected={addressLabelType === item.key}
                    onPress={() => setAddressLabelType(item.key)}
                  />
                ))}
              </View>
              {addressLabelType === 'Other' ? (
                <TextInput
                  style={locSt.fieldInput}
                  placeholder="Custom name like Mom's House"
                  placeholderTextColor={C.warmGray}
                  value={customAddressLabel}
                  onChangeText={setCustomAddressLabel}
                />
              ) : null}
              <TextInput
                style={[locSt.fieldInput, locSt.fieldInputMultiline]}
                placeholder="Full address, apartment, street, locality, pincode"
                placeholderTextColor={C.warmGray}
                value={locationAddress}
                onChangeText={setLocationAddress}
                multiline
              />
              <TextInput
                style={locSt.fieldInput}
                placeholder="Landmark or delivery note (optional)"
                placeholderTextColor={C.warmGray}
                value={locationLandmark}
                onChangeText={setLocationLandmark}
              />
              <TouchableOpacity style={locSt.photoBtn} activeOpacity={0.8} onPress={pickBuildingImage} disabled={buildingImageBusy}>
                {buildingImageUri ? (
                  <Image source={{ uri: buildingImageUri }} style={locSt.photoPreview} resizeMode="cover" />
                ) : (
                  <View style={locSt.photoPlaceholder}>
                    <Text style={locSt.photoIcon}>{'\uD83C\uDFE2'}</Text>
                  </View>
                )}
                <View style={locSt.photoCopy}>
                  <Text style={locSt.photoTitle}>{buildingImageBusy ? 'Compressing building photo...' : 'Upload building image'}</Text>
                  <Text style={locSt.photoSub}>
                    {buildingImageSize != null
                      ? `Compressed to ${(buildingImageSize / 1024).toFixed(1)} KB`
                      : 'Optional. Helps delivery staff identify the building quickly.'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            {locationSearch.trim().length > 0 && (
              <TouchableOpacity
                style={locSt.listItem}
                activeOpacity={0.75}
                onPress={() => { setLocation(locationSearch.trim()); setLocationSearch(locationSearch.trim()); setUserCoords(null); }}
              >
                <Text style={locSt.listItemIcon}>{'\uD83D\uDCCD'}</Text>
                <View>
                  <Text style={locSt.listItemName}>{locationSearch.trim()}</Text>
                  <Text style={locSt.listItemSub}>Use this location and add delivery details below</Text>
                </View>
              </TouchableOpacity>
            )}
            {([] as Array<{ name: string; sub: string }>)
              .filter(c => c.name.toLowerCase().includes(locationSearch.toLowerCase()))
              .map(city => (
                <TouchableOpacity
                  key={city.name}
                  style={[locSt.listItem, location === city.name && locSt.listItemActive]}
                  activeOpacity={0.75}
                  onPress={() => { setLocation(city.name); setLocationSearch(city.name); setUserCoords(null); }}
                >
                  <Text style={locSt.listItemIcon}>{location === city.name ? '\u2705' : '\uD83D\uDCCD'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[locSt.listItemName, location === city.name && locSt.listItemNameActive]}>{city.name}</Text>
                    <Text style={locSt.listItemSub}>{city.sub}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            <TouchableOpacity style={locSt.saveBtn} activeOpacity={0.85} onPress={saveLocationSelection}>
              <Text style={locSt.saveBtnText}>Save location</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
        </KeyboardAvoidingView>
      </Modal>


      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Home Bargain Modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      
      <Modal visible={showLocationMapModal} animationType="slide" transparent onRequestClose={() => setShowLocationMapModal(false)}>
        <View style={locSt.mapPopupBackdrop}>
          <View style={locSt.mapPopupSheet}>
            <View style={locSt.handle} />
            <Text style={locSt.title}>Pick exact location</Text>
            <Text style={locSt.mapPopupSub}>Keep the pin fixed and move the map until the center matches your exact drop point.</Text>
            {draftMapCoords ? (
              <View style={locSt.mapPopupCard}>
                <WebView
                  ref={mapWebViewRef}
                  source={mapModalHtml ? { html: mapModalHtml } : undefined}
                  style={locSt.mapPopupFrame}
                  javaScriptEnabled
                  domStorageEnabled
                  originWhitelist={['*']}
                  bounces={false}
                  overScrollMode="never"
                  onMessage={(event) => {
                    try {
                      const data = JSON.parse(event.nativeEvent.data) as { type?: string; lat?: number; lng?: number };
                      if (data.type === 'center' && typeof data.lat === 'number' && typeof data.lng === 'number') {
                        setDraftMapCoords({ lat: data.lat, lng: data.lng });
                      }
                    } catch {
                      // ignore malformed webview messages
                    }
                  }}
                />
                <View pointerEvents="none" style={locSt.fixedPinWrap}>
                  <Text style={locSt.fixedPin}>{'\uD83D\uDCCD'}</Text>
                </View>
              </View>
            ) : null}
            <View style={locSt.mapRadiusRow}>
              <Text style={locSt.mapCoordsLabel}>Geo-fencing range</Text>
              <View style={locSt.mapRadiusControls}>
                <TouchableOpacity
                  style={locSt.mapRadiusBtn}
                  activeOpacity={0.8}
                  onPress={() => setGeoRadius((current) => Math.max(1, current - 1))}
                >
                  <Text style={locSt.mapRadiusBtnText}>−</Text>
                </TouchableOpacity>
                <View style={locSt.mapRadiusValuePill}>
                  <Text style={locSt.mapRadiusValueText}>{geoRadius} km</Text>
                </View>
                <TouchableOpacity
                  style={locSt.mapRadiusBtn}
                  activeOpacity={0.8}
                  onPress={() => setGeoRadius((current) => Math.min(20, current + 1))}
                >
                  <Text style={locSt.mapRadiusBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={locSt.mapCoordsRow}>
              <Text style={locSt.mapCoordsLabel}>Selected location</Text>
              <Text style={locSt.mapCoordsValue}>
                {draftMapLocationLoading ? 'Looking up place...' : draftMapLocationName}
              </Text>
            </View>
            <View style={locSt.mapPopupActions}>
              <TouchableOpacity style={locSt.mapCancelBtn} activeOpacity={0.8} onPress={() => setShowLocationMapModal(false)}>
                <Text style={locSt.mapCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={locSt.mapConfirmBtn} activeOpacity={0.85} onPress={confirmMapLocation} disabled={!draftMapCoords || locating}>
                <Text style={locSt.mapConfirmText}>{locating ? 'Saving...' : 'Confirm location'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!homeBargainItem} transparent animationType="slide" onRequestClose={() => setHomeBargainItem(null)}>
        <TouchableOpacity style={locSt.backdrop} activeOpacity={1} onPress={() => setHomeBargainItem(null)} />
        <KeyboardAvoidingView
          style={locSt.modalWrap}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        >
        <View style={pubSt.bargainSheet}>
          <View style={pubSt.bargainHandle} />
          <View style={pubSt.bargainHeader}>
            <Text style={pubSt.bargainEmoji}>{homeBargainItem?.emoji}</Text>
            <View>
              <Text style={pubSt.bargainTitle}>Make an Offer</Text>
              <Text style={pubSt.bargainSub}>{homeBargainItem?.name}</Text>
            </View>
          </View>
          <View style={pubSt.bargainPriceRow}>
            <View style={pubSt.bargainPriceBox}>
              <Text style={pubSt.bargainPriceLabel}>Chef's Price</Text>
              <Text style={pubSt.bargainChefPrice}>₹{homeBargainItem?.chefPrice}</Text>
            </View>
            <Text style={pubSt.bargainArrow}>{'->'}</Text>
            <View style={[pubSt.bargainPriceBox, pubSt.bargainOfferBox]}>
              <Text style={pubSt.bargainPriceLabel}>Your Offer</Text>
              <View style={pubSt.bargainInputRow}>
                <Text style={pubSt.bargainRupee}>₹</Text>
                <TextInput
                  style={pubSt.bargainInput}
                  value={homeBargainOffer}
                  onChangeText={setHomeBargainOffer}
                  keyboardType="numeric"
                  maxLength={6}
                  autoFocus
                />
              </View>
            </View>
          </View>
          <View style={pubSt.platesRow}>
            <Text style={pubSt.platesLabel}>No. of Plates</Text>
            <View style={pubSt.platesStepper}>
              <TouchableOpacity style={pubSt.platesBtn} onPress={() => setHomeBargainPlates((p) => Math.max(1, p - 1))}>
                <Text style={pubSt.platesBtnText}>-</Text>
              </TouchableOpacity>
              <Text style={pubSt.platesCount}>{homeBargainPlates}</Text>
              <TouchableOpacity style={pubSt.platesBtn} onPress={() => setHomeBargainPlates((p) => Math.min(homeBargainItem?.maxPlates ?? 1, p + 1))}>
                <Text style={pubSt.platesBtnText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={pubSt.platesTotal}>Max available: {homeBargainItem?.maxPlates ?? 0} plate{(homeBargainItem?.maxPlates ?? 0) !== 1 ? 's' : ''}</Text>

          <Text style={pubSt.bargainPresetsLabel}>Quick offers</Text>
          <View style={pubSt.bargainPresets}>
            {[10, 15, 20, 25].map((pct) => {
              const offerVal = Math.round((homeBargainItem?.chefPrice ?? 0) * (1 - pct / 100));
              return (
                <TouchableOpacity key={pct} style={[pubSt.bargainPreset, homeBargainOffer === String(offerVal) && pubSt.bargainPresetActive]} activeOpacity={0.75} onPress={() => setHomeBargainOffer(String(offerVal))}>
                  <Text style={[pubSt.bargainPresetPct, homeBargainOffer === String(offerVal) && pubSt.bargainPresetPctActive]}>{pct}% off</Text>
                  <Text style={[pubSt.bargainPresetAmt, homeBargainOffer === String(offerVal) && pubSt.bargainPresetAmtActive]}>₹{offerVal}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity
            style={[pubSt.bargainSendBtn, homeBargainSending && { opacity: 0.5 }]}
            activeOpacity={0.85}
            disabled={homeBargainSending}
            onPress={sendHomeOffer}
          >
            <Text style={pubSt.bargainSendText}>{homeBargainSending ? 'Sending...' : `Send Offer · ₹${(parseInt(homeBargainOffer) || 0) * homeBargainPlates} (${homeBargainPlates} plate${homeBargainPlates > 1 ? 's' : ''})`}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={pubSt.bargainAcceptBtn}
            activeOpacity={0.85}
            onPress={async () => {
              if (!homeBargainItem || !buyerToken) return;
              setHomeBargainSending(true);

              try {
                await fetch(`${API_BASE}/offers`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    dishId: homeBargainItem.dishId,
                    chefId: homeBargainItem.chefId,
                    buyerName: buyerDisplayName,
                    buyerToken,
                    plates: homeBargainPlates,
                    offerPrice: homeBargainItem.chefPrice,
                  }),
                });
                setHomeBargainSent((prev) => ({ ...prev, [homeBargainItem.name]: homeBargainItem.chefPrice }));
                setHomeBargainItem(null);
                await loadMyOffers(buyerToken);
                goOrders();
              } finally {
                setHomeBargainSending(false);
              }
            }}
          >
            <Text style={pubSt.bargainAcceptText}>Accept at Chef's Price · ₹{(homeBargainItem?.chefPrice ?? 0) * homeBargainPlates} ({homeBargainPlates} plate{homeBargainPlates > 1 ? 's' : ''})</Text>
          </TouchableOpacity>
          <Text style={pubSt.bargainNote}>Chef will accept, counter, or decline your offer.</Text>
        </View>
        </KeyboardAvoidingView>
      </Modal>

      {!booting && screen === 'auth' ? (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView style={styles.scroll} contentContainerStyle={authSt.scrollContent} keyboardShouldPersistTaps="handled">

            {/* ── Brand header ─────────────────────────────────── */}
            <View style={authSt.brand}>
              <Image source={require('./assets/buyer-icon.png')} style={authSt.brandIcon} resizeMode="contain" />
              <View style={authSt.brandRow}>
                <Text style={authSt.brandFood}>food</Text>
                <Text style={authSt.brandSood}>sood</Text>
              </View>
              <Text style={authSt.brandTagline}>
                {authStep === 'register' ? 'Complete your profile' : authStep === 'otp' ? 'Check your inbox' : 'Sign in or create account'}
              </Text>
            </View>

            {/* ── Step 1: Email entry ───────────────────────────── */}
            {authStep === 'email' ? (
              <View style={authSt.card}>
                <Text style={authSt.stepLabel}>Your email address</Text>
                <TextInput
                  style={authSt.emailInput}
                  value={authEmail}
                  onChangeText={setAuthEmail}
                  placeholder="you@example.com"
                  placeholderTextColor="#BDB5AB"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity style={[authSt.submitBtn, otpBusy && { opacity: 0.6 }]} activeOpacity={0.85} disabled={otpBusy} onPress={sendOtp}>
                  <Text style={authSt.submitBtnText}>{otpBusy ? 'Sending…' : 'Send Verification Code'}</Text>
                </TouchableOpacity>
                <Text style={authSt.footNote}>We'll send a 6-digit code to this email. New users will be asked to complete a quick profile.</Text>
              </View>
            ) : null}

            {/* ── Step 2: OTP entry ─────────────────────────────── */}
            {authStep === 'otp' ? (
              <View style={authSt.card}>
                <Text style={authSt.stepLabel}>Verification code</Text>
                <Text style={authSt.stepSub}>Sent to <Text style={authSt.emailHighlight}>{authEmail}</Text></Text>
                <TextInput
                  style={authSt.otpInput}
                  value={authOtp}
                  onChangeText={(v) => setAuthOtp(v.replace(/\D/g, '').slice(0, 6))}
                  placeholder="• • • • • •"
                  placeholderTextColor="#BDB5AB"
                  keyboardType="number-pad"
                  maxLength={6}
                  textAlign="center"
                />
                <TouchableOpacity style={[authSt.submitBtn, otpBusy && { opacity: 0.6 }]} activeOpacity={0.85} disabled={otpBusy} onPress={verifyOtp}>
                  <Text style={authSt.submitBtnText}>{otpBusy ? 'Verifying…' : 'Verify Code'}</Text>
                </TouchableOpacity>
                <View style={authSt.resendRow}>
                  <Text style={authSt.footNote}>Didn't receive it?  </Text>
                  <TouchableOpacity activeOpacity={0.75} onPress={sendOtp} disabled={otpBusy}>
                    <Text style={authSt.switchLink}>Resend</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity style={{ marginTop: 6 }} activeOpacity={0.75} onPress={() => { setAuthStep('email'); setAuthOtp(''); }}>
                  <Text style={[authSt.footNote, { textAlign: 'center' }]}>← Change email</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {/* ── Step 3: Registration form (new users only) ────── */}
            {authStep === 'register' ? (
              <View style={authSt.card}>
                <Text style={authSt.sectionTitle}>Your name</Text>
                <View style={authSt.nameRow}>
                  <TextInput style={[authSt.emailInput, { flex: 1 }]} value={authFirstName} onChangeText={setAuthFirstName} placeholder="First name" placeholderTextColor="#BDB5AB" autoCapitalize="words" />
                  <TextInput style={[authSt.emailInput, { flex: 1 }]} value={authLastName} onChangeText={setAuthLastName} placeholder="Last name" placeholderTextColor="#BDB5AB" autoCapitalize="words" />
                </View>

                <Text style={[authSt.sectionTitle, { marginTop: 18 }]}>Phone number</Text>
                <TextInput style={authSt.emailInput} value={authRegPhone} onChangeText={(v) => setAuthRegPhone(v.replace(/\D/g, '').slice(0, 10))} placeholder="10-digit mobile number" placeholderTextColor="#BDB5AB" keyboardType="phone-pad" maxLength={10} />

                <View style={authSt.locRow}>
                  <Text style={[authSt.sectionTitle, { flex: 1, marginTop: 18 }]}>Location</Text>
                  <TouchableOpacity style={authSt.gpsBtn} activeOpacity={0.8} onPress={detectAuthLocation} disabled={authGpsLocating}>
                    <Text style={authSt.gpsBtnText}>{authGpsLocating ? 'Detecting…' : authGpsLabel ? '✓ Detected' : '📍 Auto-detect'}</Text>
                  </TouchableOpacity>
                </View>
                {authGpsLabel ? <Text style={authSt.gpsLabel}>{authGpsLabel}</Text> : null}

                <Text style={[authSt.sectionTitle, { marginTop: 18 }]}>Address details</Text>
                <TextInput style={authSt.emailInput} value={authAddrHouse} onChangeText={setAuthAddrHouse} placeholder="House / Flat / Building no." placeholderTextColor="#BDB5AB" />
                <TextInput style={[authSt.emailInput, { marginTop: 8 }]} value={authAddrStreet} onChangeText={setAuthAddrStreet} placeholder="Street / Area / Locality" placeholderTextColor="#BDB5AB" />
                <View style={[authSt.nameRow, { marginTop: 8 }]}>
                  <TextInput style={[authSt.emailInput, { flex: 1 }]} value={authAddrCity} onChangeText={setAuthAddrCity} placeholder="City" placeholderTextColor="#BDB5AB" />
                  <TextInput style={[authSt.emailInput, { flex: 1 }]} value={authAddrPincode} onChangeText={(v) => setAuthAddrPincode(v.replace(/\D/g, '').slice(0, 6))} placeholder="Pincode" placeholderTextColor="#BDB5AB" keyboardType="number-pad" maxLength={6} />
                </View>

                <TouchableOpacity style={[authSt.submitBtn, { marginTop: 24 }, otpBusy && { opacity: 0.6 }]} activeOpacity={0.85} disabled={otpBusy} onPress={completeOtpRegistration}>
                  <Text style={authSt.submitBtnText}>{otpBusy ? 'Creating account…' : 'Create Account'}</Text>
                </TouchableOpacity>
              </View>
            ) : null}

          </ScrollView>
        </KeyboardAvoidingView>
      ) : null}

      {!booting && screen === 'home' ? (
        <>
          <View style={styles.header}>
            <View style={styles.headerTop}>
              <View style={styles.brandWrap}>
                <View style={styles.brandRow}>
                  <Text style={styles.brandFood}>food</Text>
                  <Text style={styles.brandSood}>sood</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.avatarBtn} activeOpacity={0.8}>
                <Text style={styles.avatarText}>{buyerInitial}</Text>
                <View style={styles.avatarBadge} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.locationPill} activeOpacity={0.8} onPress={() => { setLocationSearch(location !== 'Set your location' ? location : ''); setShowLocationModal(true); }}>
              <Text style={styles.locationText}>Location: {location}</Text>
              {userCoords && <Text style={styles.locationGpsBadge}>{geoRadius} km</Text>}
            </TouchableOpacity>

           
          </View>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.homeScrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshBuyerData} tintColor={C.mint} />}
          >
            <BuyerHomeBanner onPress={goRequest} />



            {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Feed Tabs ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
            <BuyerHomeTabs active={feedTab} onSwitch={setFeedTab} notificationCount={unseenNotificationCount} />

            {userCoords && (
              <View style={feedSt.geoBanner}>
                <View style={feedSt.geoBannerLeft}>
                  <Text style={feedSt.geoBannerIcon}>{'\uD83C\uDFAF'}</Text>
                  <Text style={feedSt.geoBannerText}>Showing within {geoRadius} km of your location</Text>
                </View>
                <TouchableOpacity onPress={() => { setLocationSearch(''); setShowLocationModal(true); }}>
                  <Text style={feedSt.geoBannerEdit}>Change</Text>
                </TouchableOpacity>
              </View>
            )}

            {feedTab === 'requests' ? (
              notificationCards.length === 0 ? (
                <BuyerHomeEmptyState
                  emoji={'\uD83D\uDD14'}
                  title="No live activity yet"
                  subtitle={'Your requests, chef counters, payment holds,\nand active orders will show up here.'}
                  hints={[
                    { icon: '\uD83D\uDCDD', text: 'Post a request' },
                    { icon: '\uD83D\uDC68\u200D\uD83C\uDF73', text: 'Browse chefs' },
                    { icon: '\uD83D\uDCE6', text: 'Track orders' },
                  ]}
                />
              ) :
              notificationCards.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.reqCard}
                  activeOpacity={0.85}
                  onPress={() => { void openNotificationCard(item); }}
                >
                  <View style={styles.reqTopRow}>
                    <View style={styles.reqFoodRow}>
                      <View style={[styles.reqEmoji, { backgroundColor: item.emojiBg }]}>
                        <Text style={styles.reqEmojiText}>{item.emoji}</Text>
                      </View>
                      <View>
                        <Text style={styles.reqName}>{item.name}</Text>
                        <Text style={styles.reqBy}>{item.by}</Text>
                      </View>
                    </View>
                    <View style={[styles.statusBadge, { backgroundColor: item.statusBg }]}>
                      <Text style={[styles.statusText, { color: item.statusColor }]}>{item.status}</Text>
                    </View>
                  </View>
                  <View style={styles.tagsRow}>
                    {item.tags.map((tag) => (
                      <View key={tag} style={styles.tinyTag}>
                        <Text style={styles.tinyTagText}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                  <View style={styles.reqBottom}>
                    <View style={styles.reqPriceStack}>
                      <Text style={styles.reqPrice}>{item.price}</Text>
                      <Text style={styles.reqPriceLabel}>{item.priceLabel}</Text>
                      {item.secondaryPrice ? (
                        <>
                          <Text style={styles.reqPriceSecondary}>{item.secondaryPrice}</Text>
                          <Text style={styles.reqPriceSecondaryLabel}>{item.secondaryPriceLabel}</Text>
                        </>
                      ) : null}
                    </View>
                    <View style={styles.quotesRow}>
                      <View style={[styles.quotesBadge, { backgroundColor: item.quotesBg }]}>
                        <Text style={styles.quotesBadgeText}>{item.quotesCount}</Text>
                      </View>
                      <Text style={styles.quotesLabel}> {item.quotesLabel}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))
            ) : cookingLoading ? (
                <BuyerHomeEmptyState
                  emoji={'\uD83C\uDF73'}
                  title="Loading nearby dishes"
                  subtitle="Pulling live dishes from nearby chefs."
                />
            ) : filteredCooking.length === 0 ? (
                <BuyerHomeEmptyState
                  emoji={'\uD83C\uDF72'}
                  title={userCoords ? `Nothing cooking within ${geoRadius} km` : 'No live dishes yet'}
                  subtitle={userCoords ? 'Try increasing your radius in the location settings' : 'Nearby chef dishes will appear here once they start cooking.'}
                />
            ) : filteredCooking.map((item) => (
                <CookingDishCard
                  key={item.id}
                  item={item}
                  timeLeft={cookTimeLeft(item.etaMin)}
                  bargainSent={!!homeBargainSent[item.dish]}
                  onChefPress={() => goPublicChef({ id: item.chefId, name: item.chefName, initial: item.chefInitial, dish: item.dish, distance: item.distance, rating: item.rating, tags: item.tags, price: item.price, eta: cookTimeLeft(item.readyAt) ?? 'Ready now', serves: item.serves })}
                  onOrderPress={() => openHomeBargain({ dishId: item.id, chefId: item.chefId, name: item.dish, emoji: item.emoji, chefPrice: item.price, maxPlates: item.serves })}
                />
              ))}
          </ScrollView>

          <BottomNav active="home" onHomePress={goHome} onExplorePress={goExplore} onRequestPress={goRequest} onOrdersPress={goOrders} onProfilePress={goProfile} />
        </>
      ) : null}

      {screen === 'explore' ? (
        <>
          <View style={styles.postHeader}>
            <TouchableOpacity style={styles.backBtn} activeOpacity={0.75} onPress={goHome}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Explore</Text>
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>{filteredCooking.length} Live</Text>
            </View>
          </View>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.profileScrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshBuyerData} tintColor={C.mint} />}
          >
            <View style={exploreSt.hero}>
              <View style={exploreSt.heroTextWrap}>
                <Text style={exploreSt.heroKicker}>TODAY BOARD</Text>
                <Text style={exploreSt.heroTitle}>Nearby dishes live from home chefs</Text>
                <Text style={exploreSt.heroSub}>Everything listed by chefs for today, filtered by your current geo radius.</Text>
              </View>
              <View style={exploreSt.heroBadge}>
                <Text style={exploreSt.heroBadgeEmoji}>🍲</Text>
              </View>
            </View>

            <View style={feedSt.geoBanner}>
              <View style={feedSt.geoBannerLeft}>
                <Text style={feedSt.geoBannerIcon}>{'\uD83C\uDFAF'}</Text>
                <Text style={feedSt.geoBannerText}>
                  {userCoords ? `Showing dishes within ${geoRadius} km of your location` : `Showing dishes for ${location}`}
                </Text>
              </View>
              <TouchableOpacity onPress={() => { setLocationSearch(''); setShowLocationModal(true); }}>
                <Text style={feedSt.geoBannerEdit}>Change</Text>
              </TouchableOpacity>
            </View>

            <View style={exploreSt.statsRow}>
              <View style={exploreSt.statCard}>
                <Text style={exploreSt.statValue}>{filteredCooking.length}</Text>
                <Text style={exploreSt.statLabel}>Live dishes</Text>
              </View>
              <View style={exploreSt.statCard}>
                <Text style={exploreSt.statValue}>{new Set(filteredCooking.map((item) => item.chefId)).size}</Text>
                <Text style={exploreSt.statLabel}>Nearby chefs</Text>
              </View>
            </View>

            {cookingLoading ? (
              <BuyerHomeEmptyState
                emoji={'\uD83C\uDF73'}
                title="Loading nearby dishes"
                subtitle="Pulling today-board listings from nearby chefs."
              />
            ) : filteredCooking.length === 0 ? (
              <BuyerHomeEmptyState
                emoji={'\uD83C\uDF72'}
                title={userCoords ? `Nothing listed within ${geoRadius} km` : 'No live dishes yet'}
                subtitle={userCoords ? 'Try increasing your radius or changing your location.' : 'Nearby chef dishes will appear here once they start cooking.'}
              />
            ) : (
              <>
                {filteredCooking.map((item) => (
                  <CookingDishCard
                    key={`explore-${item.id}`}
                    item={item}
                    timeLeft={cookTimeLeft(item.etaMin)}
                    bargainSent={!!homeBargainSent[item.dish]}
                    onChefPress={() => goPublicChef({ id: item.chefId, name: item.chefName, initial: item.chefInitial, dish: item.dish, distance: item.distance, rating: item.rating, tags: item.tags, price: item.price, eta: cookTimeLeft(item.readyAt) ?? 'Ready now', serves: item.serves })}
                    onOrderPress={() => openHomeBargain({ dishId: item.id, chefId: item.chefId, name: item.dish, emoji: item.emoji, chefPrice: item.price, maxPlates: item.serves })}
                  />
                ))}
              </>
            )}
          </ScrollView>

          <BottomNav active="explore" onHomePress={goHome} onExplorePress={goExplore} onRequestPress={goRequest} onOrdersPress={goOrders} onProfilePress={goProfile} />
        </>
      ) : null}

      {screen === 'post-request' ? (
        <>
          <View style={styles.postHeader}>
            <TouchableOpacity style={styles.backBtn} activeOpacity={0.75} onPress={goHome}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <View style={styles.postHeaderCenter}>
              <Text style={styles.headerTitle}>Post a Request</Text>
              <Text style={styles.postStepLabel}>Step 1 of 3</Text>
            </View>
            <StepDots current={1} total={3} />
          </View>
          <View style={styles.postProgressTrack}>
            <View style={styles.postProgressFill} />
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.postScrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.fieldGroup}>
              <FieldLabel text="What are you craving?" />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.foodScroll}
              >
                {FOOD_CATEGORIES.map((item) => (
                  <TouchableOpacity key={item.id} style={[styles.foodPickItem, selectedFood === item.id ? styles.foodPickItemSelected : null]} onPress={() => handleSelectFood(item.id)} activeOpacity={0.75}>
                    <View style={[styles.fpEmojiWrap, selectedFood === item.id ? styles.fpEmojiWrapSelected : null]}>
                      <Text style={styles.fpEmoji}>{item.emoji}</Text>
                    </View>
                    <Text style={[styles.fpName, selectedFood === item.id ? styles.fpNameSelected : null]}>{item.label}</Text>
                    <Text style={[styles.fpHint, selectedFood === item.id ? styles.fpHintSelected : null]}>
                      {item.id === '12' ? 'Type your own dish' : 'Tap to start fast'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={styles.fieldGroup}>
              <FieldLabel text="Dish Name" />
              <View style={styles.dishSuggestWrap}>
                <TextInput
                  style={styles.input}
                  value={dishName}
                  onChangeText={setDishName}
                  onFocus={() => setDishNameFocused(true)}
                  onBlur={() => setTimeout(() => setDishNameFocused(false), 120)}
                  placeholder="e.g. Chicken Butter Masala"
                  placeholderTextColor="#BDB5AB"
                  autoCapitalize="words"
                />
                {dishNameFocused && filteredDishSuggestions.length > 0 ? (
                  <View style={styles.dishSuggestMenu}>
                    {filteredDishSuggestions.map((item) => (
                      <TouchableOpacity
                        key={item}
                        style={styles.dishSuggestItem}
                        onPress={() => {
                          setDishName(item);
                          setDishNameFocused(false);
                        }}
                        activeOpacity={0.8}
                      >
                        <Text style={styles.dishSuggestIcon}>Dish</Text>
                        <View style={styles.dishSuggestCopy}>
                          <Text style={styles.dishSuggestName}>{item}</Text>
                          <Text style={styles.dishSuggestSub}>From chef speciality dishes</Text>
                        </View>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <FieldLabel text="Quantity" />
              <View style={styles.qtyBox}>
                <View style={styles.qtyTopRow}>
                  <Text style={styles.qtyValue}>{isThali ? `${thaliPlates}` : quantityDisplayLabel}</Text>
                  <Text style={styles.qtySubValue}>{isThali ? (thaliPlates === 1 ? 'plate' : 'plates') : '0 g to 2 kg'}</Text>
                </View>
                {isThali ? (
                  <>
                    <Slider
                      style={styles.qtySlider}
                      minimumValue={1}
                      maximumValue={10}
                      step={1}
                      minimumTrackTintColor={C.spice}
                      maximumTrackTintColor={C.border}
                      thumbTintColor={C.spice}
                      value={thaliPlates}
                      onValueChange={(value) => setThaliPlates(Math.round(value))}
                    />
                    <View style={styles.qtyRangeRow}>
                      <Text style={styles.qtyRangeText}>1 plate</Text>
                      <Text style={styles.qtyRangeText}>10 plates</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <Slider
                      style={styles.qtySlider}
                      minimumValue={0}
                      maximumValue={2000}
                      step={50}
                      minimumTrackTintColor={C.spice}
                      maximumTrackTintColor={C.border}
                      thumbTintColor={C.spice}
                      value={qtyGrams}
                      onValueChange={(value) => setQtyGrams(Math.round(value))}
                    />
                    <View style={styles.qtyRangeRow}>
                      <Text style={styles.qtyRangeText}>0 g</Text>
                      <Text style={styles.qtyRangeText}>2 kg</Text>
                    </View>
                  </>
                )}
                <View style={styles.servingHintCard}>
                  <Text style={styles.servingHintLabel}>{isThali ? 'Each thali includes' : 'Suggested serving'}</Text>
                  <Text style={styles.servingHintValue}>
                    {servingSummaryLabel}
                  </Text>
                  <Text style={styles.servingHintSub}>{isThali ? THALI_INCLUDES : quantityGuide.helper}</Text>
                </View>
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <FieldLabel text="Spice Level" />
              <View style={styles.chipRow}>
                {SPICE_LEVELS.map((item) => (
                  <Chip key={item.id} label={item.label} selected={spice === item.id} onPress={() => setSpice(item.id)} />
                ))}
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <FieldLabel text="Preferences" />
              <View style={styles.chipRow}>
                {visiblePrefs.map((item) => (
                  <Chip key={item.id} label={item.label} selected={prefs.includes(item.id)} onPress={() => togglePref(item.id)} />
                ))}
                {!showAllPrefs && PREFS.length > collapsedPrefs.length ? (
                  <TouchableOpacity style={styles.prefInlineMoreBtn} onPress={() => setShowAllPrefs(true)} activeOpacity={0.75}>
                    <Text style={styles.prefInlineMoreText}>See more</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {showAllPrefs && PREFS.length > collapsedPrefs.length ? (
                <TouchableOpacity style={styles.prefMoreBtn} onPress={() => setShowAllPrefs((current) => !current)} activeOpacity={0.75}>
                  <Text style={styles.prefMoreText}>See less</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <View style={styles.fieldGroup}>
              <TouchableOpacity style={styles.sectionToggleRow} onPress={() => setShowSides((current) => !current)} activeOpacity={0.75}>
                <FieldLabel text="Sides" />
                <Text style={styles.sectionToggleText}>{showSides ? 'Hide' : 'Add sides'}</Text>
              </TouchableOpacity>
              {showSides ? (
                <View style={styles.sideList}>
                  {SIDE_OPTIONS.map((item) => {
                    const qty = sideQty[item.id] ?? 0;
                    return (
                      <View key={item.id} style={[styles.sideCard, qty > 0 ? styles.sideCardActive : null]}>
                        <View style={styles.sideCopy}>
                          <Text style={styles.sideName}>{item.label}</Text>
                          <Text style={styles.sideMeta}>{item.unit}</Text>
                        </View>
                        <View style={styles.sideStepper}>
                          <TouchableOpacity style={styles.sideStepBtn} onPress={() => updateSideQty(item.id, qty - 1)} activeOpacity={0.75}>
                            <Text style={styles.sideStepText}>-</Text>
                          </TouchableOpacity>
                          <Text style={styles.sideQty}>{qty}</Text>
                          <TouchableOpacity style={styles.sideStepBtn} onPress={() => updateSideQty(item.id, qty + 1)} activeOpacity={0.75}>
                            <Text style={styles.sideStepText}>+</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.sectionToggleHint}>Keep rotis, plain rice, salad and other sides if needed.</Text>
              )}
            </View>

            <View style={styles.fieldGroup}>
              <FieldLabel text="Remarks" />
              <TextInput
                style={styles.remarksInput}
                value={remarks}
                onChangeText={setRemarks}
                placeholder="Any extra notes for the chef..."
                placeholderTextColor="#BDB5AB"
                multiline
                textAlignVertical="top"
              />
            </View>

            <View style={styles.fieldGroup}>
              <FieldLabel text="Your Budget" />
              <View style={styles.budgetBox}>
                <Text style={styles.budgetNote}>Type your maximum price</Text>
                <View style={styles.budgetInputRow}>
                  <Text style={styles.budgetInputPrefix}>₹</Text>
                  <TextInput
                    style={styles.budgetInput}
                    value={budget === 0 ? '' : String(budget)}
                    onChangeText={(value) => {
                      const digits = value.replace(/[^0-9]/g, '');
                      setBudget(digits ? Number(digits) : 0);
                    }}
                    keyboardType="number-pad"
                    placeholder="Enter budget"
                    placeholderTextColor="#BDB5AB"
                  />
                </View>
                <View style={styles.marketPriceCard}>
                  <Text style={styles.marketPriceLabel}>Today&apos;s market price</Text>
                  <Text style={styles.marketPriceValue}>
                    {selectedFood === '1' ? 'Chicken: Rs 300-Rs 350 per kg' : 'Live market price coming soon'}
                  </Text>
                  <Text style={styles.marketPriceSub}>
                    Static for now. Later this can be connected to live market pricing.
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <FieldLabel text="Delivery Option" />
              <View style={styles.chipRow}>
                {DELIVERY.map((item) => (
                  <Chip key={item.id} label={item.label} selected={delivery === item.id} onPress={() => setDelivery(item.id)} />
                ))}
              </View>
            </View>

            <View style={styles.cookNote}>
              <Text style={styles.cookNoteIcon}>ℹ</Text>
              <Text style={styles.cookNoteText}>Minimum cooking time is <Text style={styles.cookNoteStrong}>2 hours</Text>. Your request will remain open until a chef accepts.</Text>
            </View>

            <TouchableOpacity style={[styles.submitBtn, postingRequest && { opacity: 0.7 }]} activeOpacity={0.85} onPress={goFloated} disabled={postingRequest}>
              <Text style={styles.submitBtnText}>{postingRequest ? 'Posting Request...' : 'Find Chefs & Post Request'}</Text>
            </TouchableOpacity>

            <View style={styles.bottomSpacer} />
          </ScrollView>

          <BottomNav active="request" onHomePress={goHome} onExplorePress={goExplore} onRequestPress={goRequest} onOrdersPress={goOrders} onProfilePress={goProfile} />
        </>
      ) : null}

      {screen === 'chef-profile' ? (
        <ChefProfileScreen onBack={goProfile} />
      ) : null}

      {screen === 'public-chef' && viewingChef ? (
        <PublicChefProfileScreen
          chef={viewingChef}
          onBack={goHome}
          onRequest={goRequest}
          isSaved={isChefSaved(viewingChef.id)}
          onToggleSave={toggleSavedChef}
        />
      ) : null}

      {screen === 'request-floated' && floatedDish ? (
        <RequestFloatedScreen
          dish={floatedDish}
          quoteCount={currentRequest?.quotesCount ?? 0}
          onViewQuotes={goQuotes}
          onCancel={goHome}
          onHome={goHome}
        />
      ) : null}

      {screen === 'quotes' ? (
        <>
          <View style={styles.postHeader}>
            <TouchableOpacity style={styles.backBtn} activeOpacity={0.75} onPress={goRequest}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Chef Quotes</Text>
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>{requestQuoteCards.length} New</Text>
            </View>
          </View>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.homeScrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshBuyerData} tintColor={C.mint} />}
          >
            <View style={styles.quotesTopPad}>
              <OrderSummaryCard
                budget={quotesBudget}
                emoji={floatedDish?.emoji}
                title={floatedDish?.dishName ?? currentRequest?.dishName ?? 'Your Request'}
                subtitle={
                  floatedDish
                    ? `${floatedDish.quantityLabel ?? `${floatedDish.qtyGrams} g`} | serves ${floatedDish.servings}`
                    : 'Live quotes from nearby chefs'
                }
              />
            </View>

            <View style={styles.quotesHeading}>
              <Text style={styles.sectionHeading}>Quotes Received</Text>
              <Text style={styles.quotesCount}>{requestQuoteCards.length} chef{requestQuoteCards.length === 1 ? '' : 's'} responded</Text>
            </View>

            {requestQuoteCards.length === 0 ? (
              <View style={orderTabSt.emptyCard}>
                <Text style={orderTabSt.emptyEmoji}>🔔</Text>
                <Text style={orderTabSt.emptyTitle}>No live quotes yet</Text>
                <Text style={orderTabSt.emptySub}>Nearby chefs will start responding here once they review your request.</Text>
              </View>
            ) : requestQuoteCards.map((quote) => (
              <QuoteCard
                key={quote.id}
                item={quote}
                onAccept={async () => {
                  try {
                    if (buyerProfile) {
                      await buyerApi(`/quotes/${quote.rawQuote.id}/accept`, {
                        method: 'POST',
                        body: JSON.stringify({}),
                      });
                    } else {
                      if (!buyerToken) return;
                      const res = await fetch(`${API_BASE}/quotes/${quote.rawQuote.id}/public-accept`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ buyerToken }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not accept quote');
                    }
                    if (currentRequestId) await loadCurrentRequest(currentRequestId);
                    await loadMyRequestOrders();
                    Alert.alert('Quote accepted', 'Your order is now on a 10-minute payment hold. Complete payment to confirm it.');
                    goOrders();
                  } catch (error) {
                    Alert.alert('Accept failed', error instanceof Error ? error.message : 'Could not accept this quote.');
                  }
                }}
                onReject={async () => {
                  try {
                    if (buyerProfile) {
                      await buyerApi(`/quotes/${quote.rawQuote.id}/reject`, {
                        method: 'POST',
                        body: JSON.stringify({}),
                      });
                    } else {
                      if (!buyerToken) return;
                      const res = await fetch(`${API_BASE}/quotes/${quote.rawQuote.id}/public-reject`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ buyerToken }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not reject quote');
                    }
                    if (currentRequestId) await loadCurrentRequest(currentRequestId);
                  } catch (error) {
                    Alert.alert('Reject failed', error instanceof Error ? error.message : 'Could not reject this quote.');
                  }
                }}
                onCounter={() => setCounterChef(quote)}
              />
            ))}

            <View style={styles.raiseStrip}>
              <View>
                <Text style={styles.raiseTitle}>Not satisfied? Raise your budget</Text>
                <Text style={styles.raiseSub}>More chefs will respond with better offers</Text>
              </View>
              <TouchableOpacity style={styles.raiseBtn} onPress={handleRaiseBudget} activeOpacity={0.85}>
                <Text style={styles.raiseBtnText}>↑ +₹50</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.tipBox}>
              <Text style={styles.tipIcon}>💡</Text>
              <Text style={styles.tipText}>Tip: Chefs with 4.8★+ and under 1 km are most likely to accept within 15 minutes.</Text>
            </View>
          </ScrollView>

          <BottomNav active="orders" onHomePress={goHome} onExplorePress={goExplore} onRequestPress={goRequest} onOrdersPress={goOrders} onProfilePress={goProfile} />
        </>
      ) : null}

      {screen === 'orders' ? (
        <>
          <View style={styles.postHeader}>
            <TouchableOpacity style={styles.backBtn} activeOpacity={0.75} onPress={goHome}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>My Orders</Text>
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>{placedOrders.length + requestPlacedOrders.length} Active</Text>
            </View>
          </View>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.profileScrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshBuyerData} tintColor={C.mint} />}
          >
            {/* Stats row */}
            <View style={orderTabSt.summaryRow}>
              <View style={[orderTabSt.summaryTile, { backgroundColor: C.paleYellow }]}>
                <Text style={[orderTabSt.summaryValue, { color: C.turmeric }]}>{pendingApprovalOrders.length}</Text>
                <Text style={orderTabSt.summaryLabel}>Awaiting{'\n'}Chef</Text>
              </View>
              <View style={[orderTabSt.summaryTile, { backgroundColor: C.blush }]}>
                <Text style={[orderTabSt.summaryValue, { color: C.spice }]}>{holdOrders.length + requestHoldOrders.length}</Text>
                <Text style={orderTabSt.summaryLabel}>Payment{'\n'}Due</Text>
              </View>
              <View style={[orderTabSt.summaryTile, { backgroundColor: C.paleGreen }]}>
                <Text style={[orderTabSt.summaryValue, { color: C.mint }]}>{placedOrders.length + requestPlacedOrders.length}</Text>
                <Text style={orderTabSt.summaryLabel}>Active{'\n'}Orders</Text>
              </View>
            </View>

            {buyerOrderSections.map((section) => (
              <View key={section.key}>
                <View style={orderTabSt.sectionHeader}>
                  <Text style={orderTabSt.sectionEmoji}>{section.emoji}</Text>
                  <Text style={orderTabSt.sectionTitle}>{section.title}</Text>
                  {section.count > 0 ? (
                    <View style={[orderTabSt.sectionBadge, { backgroundColor: section.badgeBg }]}>
                      <Text style={orderTabSt.sectionBadgeText}>{section.count}</Text>
                    </View>
                  ) : null}
                </View>

                {section.key === 'approval' ? (
                  pendingApprovalOrders.length === 0 ? (
                    <View style={orderTabSt.emptyCard}>
                      <Text style={orderTabSt.emptyEmoji}>⏳</Text>
                      <Text style={orderTabSt.emptyTitle}>Nothing awaiting approval</Text>
                      <Text style={orderTabSt.emptySub}>When you place an order at the chef's listed price, they must accept it before payment opens.</Text>
                    </View>
                  ) : pendingApprovalOrders.map((offer) => (
                    <PendingApprovalCard key={offer.id} offer={offer} />
                  ))
                ) : null}

                {section.key === 'payment' ? (
                  holdOrders.length + requestHoldOrders.length === 0 ? (
                    <View style={orderTabSt.emptyCard}>
                      <Text style={orderTabSt.emptyEmoji}>💳</Text>
                      <Text style={orderTabSt.emptyTitle}>No orders waiting for payment</Text>
                      <Text style={orderTabSt.emptySub}>Once the chef accepts, the dish is held here for 10 minutes so you can complete payment.</Text>
                    </View>
                  ) : (
                    <>
                      {holdOrders.map((offer) => (
                        <HoldOrderCard
                          key={offer.id}
                          offer={offer}
                          timeLeft={holdTimeLeft(offer.holdUntil)}
                          onPay={() => {
                            setCheckoutRequestOrder(null);
                            setCheckoutOffer(offer);
                            setCheckoutDelivery(offer.deliveryMode ?? 'pickup');
                            setBringOwnContainer(false);
                          }}
                        />
                      ))}
                      {requestHoldOrders.map((order) => (
                        <RequestHoldOrderCard
                          key={order.id}
                          order={order}
                          timeLeft={holdTimeLeft(order.holdUntil)}
                          onPay={() => {
                            setCheckoutOffer(null);
                            setCheckoutRequestOrder(order);
                          }}
                        />
                      ))}
                    </>
                  )
                ) : null}

                {section.key === 'confirmed' ? (
                  placedOrders.length + requestPlacedOrders.length === 0 ? (
                    <View style={orderTabSt.emptyCard}>
                      <Text style={orderTabSt.emptyEmoji}>📦</Text>
                      <Text style={orderTabSt.emptyTitle}>No confirmed orders yet</Text>
                      <Text style={orderTabSt.emptySub}>Paid orders appear here instantly after payment succeeds.</Text>
                    </View>
                  ) : (
                    <>
                      {placedOrders.map((offer) => (
                        <PlacedOrderCard key={offer.id} offer={offer} onPayBalance={offer.status === 'ADVANCE_PAID' ? () => payBalanceForOffer(offer) : undefined} />
                      ))}
                      {requestPlacedOrders.map((order) => (
                        <RequestPlacedOrderCard key={order.id} order={order} onPayBalance={order.paymentStatus === 'ADVANCE_PAID' ? () => payBalanceForRequestOrder(order) : undefined} />
                      ))}
                    </>
                  )
                ) : null}
              </View>
            ))}

          </ScrollView>

          <BottomNav active="orders" onHomePress={goHome} onExplorePress={goExplore} onRequestPress={goRequest} onOrdersPress={goOrders} onProfilePress={goProfile} />
        </>
      ) : null}

      <Modal visible={reviewPromptOffer !== null} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={reviewPromptSt.backdrop}>
          <View style={reviewPromptSt.sheet}>
            <View style={reviewPromptSt.badge}>
              <Text style={reviewPromptSt.badgeText}>REVIEW REMINDER</Text>
            </View>
            <Text style={reviewPromptSt.title}>How was your order?</Text>
            {reviewPromptOffer ? (
              <Text style={reviewPromptSt.sub}>
                {reviewPromptOffer.dishEmoji} {reviewPromptOffer.dishName} · Your review helps us maintain our service and spotlight the best home chefs.
              </Text>
            ) : null}

            <Text style={reviewPromptSt.label}>Tap to rate</Text>
            <View style={reviewPromptSt.starRow}>
              {[1, 2, 3, 4, 5].map((value) => (
                <TouchableOpacity key={value} activeOpacity={0.8} onPress={() => setReviewRating(value)}>
                  <Text style={[reviewPromptSt.star, value <= reviewRating && reviewPromptSt.starActive]}>*</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={reviewPromptSt.label}>Add a quick review</Text>
            <TextInput
              style={reviewPromptSt.input}
              value={reviewComment}
              onChangeText={setReviewComment}
              multiline
              textAlignVertical="top"
              placeholder="Share what you loved, or what could be better."
              placeholderTextColor={C.warmGray}
            />

            <TouchableOpacity style={reviewPromptSt.submitBtn} activeOpacity={0.85} onPress={submitReviewPrompt}>
              <Text style={reviewPromptSt.submitBtnText}>Submit Review</Text>
            </TouchableOpacity>
            <TouchableOpacity style={reviewPromptSt.snoozeBtn} activeOpacity={0.8} onPress={snoozeReviewPrompt}>
              <Text style={reviewPromptSt.snoozeBtnText}>Snooze for 12 hours</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={selectedNotification !== null} transparent animationType="slide" onRequestClose={() => setSelectedNotification(null)}>
        <TouchableOpacity style={locSt.backdrop} activeOpacity={1} onPress={() => setSelectedNotification(null)} />
        <View style={notifSheetSt.sheet}>
          <View style={notifSheetSt.handle} />
          {selectedNotification ? (
            <>
              {(() => {
                const holdOffer = selectedNotification.rawOffer?.status === 'HOLD' ? selectedNotification.rawOffer : null;
                const counteredOffer = selectedNotification.rawOffer?.status === 'COUNTERED' ? selectedNotification.rawOffer : null;
                const holdRequestOrder = selectedNotification.rawRequest?.order?.paymentStatus === 'HOLD'
                  ? myRequestOrders.find((order) => order.requestId === selectedNotification.rawRequest?.id && order.paymentStatus === 'HOLD') ?? null
                  : null;
                const actionableRequestQuote = selectedNotification.rawRequest?.quotes
                  ?.filter((quote) => quote.status === 'COUNTERED' || quote.status === 'PENDING')
                  .sort((a, b) => (a.counterOffer ?? a.price) - (b.counterOffer ?? b.price))[0] ?? null;
                const actionableQuoteCard = selectedNotification.rawRequest && actionableRequestQuote
                  ? mapBuyerQuoteCard(selectedNotification.rawRequest, actionableRequestQuote, 0, 1)
                  : null;
                const hasActionableRequestQuote = !!(actionableQuoteCard && !holdOffer && !holdRequestOrder && (actionableQuoteCard.rawQuote.status === 'COUNTERED' || actionableQuoteCard.rawQuote.status === 'PENDING'));
                return (
                  <>
              <View style={notifSheetSt.header}>
                <View style={[notifSheetSt.emojiWrap, { backgroundColor: selectedNotification.emojiBg }]}>
                  <Text style={notifSheetSt.emoji}>{selectedNotification.emoji}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={notifSheetSt.title}>{selectedNotification.name}</Text>
                  <Text style={notifSheetSt.sub}>{selectedNotification.by}</Text>
                </View>
                <View style={[notifSheetSt.statusPill, { backgroundColor: selectedNotification.statusBg }]}>
                  <Text style={[notifSheetSt.statusText, { color: selectedNotification.statusColor }]}>{selectedNotification.status}</Text>
                </View>
              </View>

              <View style={notifSheetSt.priceRow}>
                <View style={notifSheetSt.priceCard}>
                  <Text style={notifSheetSt.priceLabel}>{selectedNotification.priceLabel}</Text>
                  <Text style={notifSheetSt.priceValue}>{selectedNotification.price}</Text>
                </View>
                <View style={notifSheetSt.priceCard}>
                  <Text style={notifSheetSt.priceLabel}>Live update</Text>
                  <Text style={notifSheetSt.priceMeta}>{selectedNotification.quotesCount} {selectedNotification.quotesLabel}</Text>
                </View>
              </View>

              {selectedNotification.tags.length ? (
                <View style={notifSheetSt.tagsRow}>
                  {selectedNotification.tags.map((tag) => (
                    <View key={tag} style={notifSheetSt.tag}>
                      <Text style={notifSheetSt.tagText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {selectedNotification.rawRequest ? (
                <View style={notifSheetSt.detailCard}>
                  <Text style={notifSheetSt.detailTitle}>Request Details</Text>
                  <Text style={notifSheetSt.detailLine}>Budget: Rs {selectedNotification.rawRequest.budget}</Text>
                  <Text style={notifSheetSt.detailLine}>Delivery: {selectedNotification.rawRequest.delivery}</Text>
                  <Text style={notifSheetSt.detailLine}>Spice: {selectedNotification.rawRequest.spiceLevel}</Text>
                  {actionableQuoteCard ? <Text style={notifSheetSt.detailLine}>Latest quote: Rs {actionableQuoteCard.price}</Text> : null}
                  {selectedNotification.rawRequest.notes ? <Text style={notifSheetSt.detailNote}>{selectedNotification.rawRequest.notes}</Text> : null}
                </View>
              ) : null}

              {selectedNotification.rawOffer ? (
                <View style={notifSheetSt.detailCard}>
                  <Text style={notifSheetSt.detailTitle}>Offer Details</Text>
                  <Text style={notifSheetSt.detailLine}>Plates: {selectedNotification.rawOffer.plates}</Text>
                  <Text style={notifSheetSt.detailLine}>Offer price: Rs {selectedNotification.rawOffer.agreedPrice ?? selectedNotification.rawOffer.counterPrice ?? selectedNotification.rawOffer.offerPrice}</Text>
                  <Text style={notifSheetSt.detailLine}>Delivery: {selectedNotification.rawOffer.deliveryMode ?? 'Pending'}</Text>
                  {selectedNotification.rawOffer.counterNote ? <Text style={notifSheetSt.detailNote}>{selectedNotification.rawOffer.counterNote}</Text> : null}
                </View>
              ) : null}

              {holdOffer || holdRequestOrder ? (
                <TouchableOpacity
                  style={notifSheetSt.payBtn}
                  activeOpacity={0.85}
                  onPress={() => {
                    setSelectedNotification(null);
                    if (holdOffer) {
                      setCheckoutOffer(holdOffer);
                      setCheckoutDelivery(holdOffer.deliveryMode === 'delivery' ? 'delivery' : 'pickup');
                      return;
                    }
                    if (holdRequestOrder) {
                      setCheckoutRequestOrder(holdRequestOrder);
                    }
                  }}
                >
                  <Text style={notifSheetSt.payBtnText}>
                    {holdOffer
                      ? `Pay Now ${holdTimeLeft(holdOffer.holdUntil) ? `· ${holdTimeLeft(holdOffer.holdUntil)} left` : ''}`
                      : `Pay Now ${holdTimeLeft(holdRequestOrder?.holdUntil) ? `· ${holdTimeLeft(holdRequestOrder?.holdUntil)} left` : ''}`}
                  </Text>
                </TouchableOpacity>
              ) : null}

              {!holdOffer && !holdRequestOrder && counteredOffer ? (
                <>
                  <TouchableOpacity
                    style={notifSheetSt.payBtn}
                    activeOpacity={0.85}
                    onPress={async () => {
                      try {
                        if (!buyerToken) return;
                        const res = await fetch(`${API_BASE}/offers/${counteredOffer.id}/buyer-accept`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ buyerToken }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not accept counter');
                        await loadMyOffers(buyerToken);
                        setSelectedNotification(null);
                        goOrders();
                      } catch (error) {
                        Alert.alert('Accept failed', error instanceof Error ? error.message : 'Could not accept this counter.');
                      }
                    }}
                  >
                    <Text style={notifSheetSt.payBtnText}>Accept ₹{counteredOffer.counterPrice ?? counteredOffer.offerPrice}</Text>
                  </TouchableOpacity>

                  <View style={notifSheetSt.actionRow}>
                    <TouchableOpacity
                      style={notifSheetSt.counterBtn}
                      activeOpacity={0.85}
                      onPress={() => {
                        setSelectedNotification(null);
                        setRespondOffer(counteredOffer);
                        setRespondPrice(String(counteredOffer.offerPrice));
                      }}
                    >
                      <Text style={notifSheetSt.counterBtnText}>Counter</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={notifSheetSt.rejectBtn}
                      activeOpacity={0.85}
                      onPress={async () => {
                        try {
                          if (!buyerToken) return;
                          const res = await fetch(`${API_BASE}/offers/${counteredOffer.id}/buyer-reject`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ buyerToken }),
                          });
                          const data = await res.json();
                          if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not reject counter');
                          await loadMyOffers(buyerToken);
                          setSelectedNotification(null);
                        } catch (error) {
                          Alert.alert('Reject failed', error instanceof Error ? error.message : 'Could not reject this counter.');
                        }
                      }}
                    >
                      <Text style={notifSheetSt.rejectBtnText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}

              {hasActionableRequestQuote ? (
                <>
                  <TouchableOpacity
                    style={notifSheetSt.payBtn}
                    activeOpacity={0.85}
                    onPress={async () => {
                      try {
                        if (buyerProfile) {
                          await buyerApi(`/quotes/${actionableQuoteCard.rawQuote.id}/accept`, {
                            method: 'POST',
                            body: JSON.stringify({}),
                          });
                        } else {
                          if (!buyerToken) return;
                          const res = await fetch(`${API_BASE}/quotes/${actionableQuoteCard.rawQuote.id}/public-accept`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ buyerToken }),
                          });
                          const data = await res.json();
                          if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not accept quote');
                        }
                        if (selectedNotification.rawRequest?.id) await loadCurrentRequest(selectedNotification.rawRequest.id);
                        await loadMyRequests();
                        await loadMyRequestOrders();
                        setSelectedNotification(null);
                        Alert.alert('Quote accepted', 'Your order is now on a 10-minute payment hold. Complete payment to confirm it.');
                        goOrders();
                      } catch (error) {
                        Alert.alert('Accept failed', error instanceof Error ? error.message : 'Could not accept this quote.');
                      }
                    }}
                  >
                    <Text style={notifSheetSt.payBtnText}>
                      {actionableQuoteCard?.rawQuote.status === 'PENDING' ? 'Hold' : 'Accept'} ₹{actionableQuoteCard.price}
                    </Text>
                  </TouchableOpacity>

                  <View style={notifSheetSt.actionRow}>
                    {actionableQuoteCard.buyerCountersLeft > 0 ? (
                      <TouchableOpacity
                        style={notifSheetSt.counterBtn}
                        activeOpacity={0.85}
                        onPress={() => {
                          setSelectedNotification(null);
                          setCounterChef(actionableQuoteCard);
                        }}
                      >
                        <Text style={notifSheetSt.counterBtnText}>Counter</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={notifSheetSt.rejectBtn}
                      activeOpacity={0.85}
                      onPress={async () => {
                        try {
                          if (buyerProfile) {
                            await buyerApi(`/quotes/${actionableQuoteCard.rawQuote.id}/reject`, {
                              method: 'POST',
                              body: JSON.stringify({}),
                            });
                          } else {
                            if (!buyerToken) return;
                            const res = await fetch(`${API_BASE}/quotes/${actionableQuoteCard.rawQuote.id}/public-reject`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ buyerToken }),
                            });
                            const data = await res.json();
                            if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not reject quote');
                          }
                          await loadMyRequests();
                          if (selectedNotification.rawRequest?.id) await loadCurrentRequest(selectedNotification.rawRequest.id);
                          setSelectedNotification(null);
                        } catch (error) {
                          Alert.alert('Reject failed', error instanceof Error ? error.message : 'Could not reject this quote.');
                        }
                      }}
                    >
                      <Text style={notifSheetSt.rejectBtnText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : null}

              {!(counteredOffer || hasActionableRequestQuote) ? (
                <TouchableOpacity style={notifSheetSt.closeBtn} activeOpacity={0.85} onPress={() => setSelectedNotification(null)}>
                  <Text style={notifSheetSt.closeBtnText}>Close</Text>
                </TouchableOpacity>
              ) : null}
                  </>
                );
              })()}
            </>
          ) : null}
        </View>
      </Modal>

      <Modal visible={checkoutOffer !== null || checkoutRequestOrder !== null} transparent animationType="slide" onRequestClose={() => { setCheckoutOffer(null); setCheckoutRequestOrder(null); setCheckoutPaymentType('full'); }}>
        <TouchableOpacity style={locSt.backdrop} activeOpacity={1} onPress={() => { setCheckoutOffer(null); setCheckoutRequestOrder(null); setCheckoutPaymentType('full'); }} />
        <View style={orderTabSt.checkoutSheet}>
          <View style={pubSt.bargainHandle} />
          <Text style={orderTabSt.checkoutTitle}>Confirm Order</Text>
          {checkoutOffer ? (
            <>
              <Text style={orderTabSt.checkoutSub}>{checkoutOffer.dishEmoji} {checkoutOffer.dishName} · {checkoutOffer.plates} plate{checkoutOffer.plates > 1 ? 's' : ''}</Text>
              <Text style={orderTabSt.checkoutTimer}>Complete payment in {holdTimeLeft(checkoutOffer.holdUntil) ?? '0:00'}</Text>
            </>
          ) : null}

          {checkoutRequestOrder ? (
            <>
              <Text style={orderTabSt.checkoutSub}>
                {(FOOD_CATEGORIES.find((item) => item.label.toLowerCase() === checkoutRequestOrder.request.category.toLowerCase())?.emoji ?? 'Custom')} {checkoutRequestOrder.request.dishName} · Request order
              </Text>
              <Text style={orderTabSt.checkoutTimer}>Complete payment in {holdTimeLeft(checkoutRequestOrder.holdUntil) ?? '0:00'}</Text>
            </>
          ) : null}

          {checkoutOffer ? (
            <>
              <Text style={orderTabSt.checkoutLabel}>Delivery option</Text>
              <View style={orderTabSt.deliveryRow}>
                <TouchableOpacity style={[orderTabSt.deliveryChip, checkoutDelivery === 'pickup' && orderTabSt.deliveryChipActive]} activeOpacity={0.8} onPress={() => setCheckoutDelivery('pickup')}>
                  <Text style={[orderTabSt.deliveryChipText, checkoutDelivery === 'pickup' && orderTabSt.deliveryChipTextActive]}>Self Pickup</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[orderTabSt.deliveryChip, checkoutDelivery === 'delivery' && orderTabSt.deliveryChipActive]} activeOpacity={0.8} onPress={() => setCheckoutDelivery('delivery')}>
                  <Text style={[orderTabSt.deliveryChipText, checkoutDelivery === 'delivery' && orderTabSt.deliveryChipTextActive]}>Home Delivery</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : null}

          {checkoutOffer && checkoutDelivery === 'pickup' ? (
            <TouchableOpacity style={orderTabSt.checkboxRow} activeOpacity={0.8} onPress={() => setBringOwnContainer((curr) => !curr)}>
              <View style={[orderTabSt.checkbox, bringOwnContainer && orderTabSt.checkboxActive]}>
                {bringOwnContainer ? <Text style={orderTabSt.checkboxTick}>✓</Text> : null}
              </View>
              <Text style={orderTabSt.checkboxLabel}>I will bring my own container</Text>
            </TouchableOpacity>
          ) : null}

          {(() => {
            const baseTotal = checkoutOffer ? (checkoutOffer.agreedPrice ?? checkoutOffer.offerPrice) * checkoutOffer.plates : checkoutRequestOrder?.finalPrice ?? 0;
            const pickupDiscount = checkoutOffer && checkoutDelivery === 'pickup' ? Math.min(Math.round(baseTotal * 0.05), 30) : 0;
            const finalTotal = baseTotal - pickupDiscount;
            const advanceAmount = Math.ceil(finalTotal * 0.2);
            const balanceDue = finalTotal - advanceAmount;
            const payNow = checkoutPaymentType === 'advance' ? advanceAmount : finalTotal;
            return (
              <>
                <Text style={orderTabSt.checkoutLabel}>Payment option</Text>
                <View style={orderTabSt.deliveryRow}>
                  <TouchableOpacity style={[orderTabSt.deliveryChip, checkoutPaymentType === 'full' && orderTabSt.deliveryChipActive]} activeOpacity={0.8} onPress={() => setCheckoutPaymentType('full')}>
                    <Text style={[orderTabSt.deliveryChipText, checkoutPaymentType === 'full' && orderTabSt.deliveryChipTextActive]}>Full Payment</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[orderTabSt.deliveryChip, checkoutPaymentType === 'advance' && orderTabSt.deliveryChipActive]} activeOpacity={0.8} onPress={() => setCheckoutPaymentType('advance')}>
                    <Text style={[orderTabSt.deliveryChipText, checkoutPaymentType === 'advance' && orderTabSt.deliveryChipTextActive]}>Pay 20% Advance</Text>
                  </TouchableOpacity>
                </View>

                <View style={orderTabSt.demoPayCard}>
                  <Text style={orderTabSt.demoPayLabel}>Order Summary</Text>
                  <View style={orderTabSt.payBreakdown}>
                    <View style={orderTabSt.payRow}>
                      <Text style={orderTabSt.payRowLabel}>Negotiated price</Text>
                      <Text style={orderTabSt.payRowValue}>Rs {baseTotal}</Text>
                    </View>
                    {pickupDiscount > 0 ? (
                      <View style={orderTabSt.payRow}>
                        <Text style={orderTabSt.payDiscountLabel}>Self pickup discount (5%)</Text>
                        <Text style={orderTabSt.payDiscountValue}>-Rs {pickupDiscount}</Text>
                      </View>
                    ) : null}
                    <View style={orderTabSt.payDivider} />
                    {checkoutPaymentType === 'advance' ? (
                      <>
                        <View style={orderTabSt.payRow}>
                          <Text style={orderTabSt.payTotalLabel}>Pay now (20% advance)</Text>
                          <Text style={orderTabSt.payTotalValue}>Rs {advanceAmount}</Text>
                        </View>
                        <View style={orderTabSt.payRow}>
                          <Text style={orderTabSt.payRowLabel}>Balance due later</Text>
                          <Text style={orderTabSt.payRowValue}>Rs {balanceDue}</Text>
                        </View>
                      </>
                    ) : (
                      <View style={orderTabSt.payRow}>
                        <Text style={orderTabSt.payTotalLabel}>You pay</Text>
                        <Text style={orderTabSt.payTotalValue}>Rs {finalTotal}</Text>
                      </View>
                    )}
                  </View>
                  {checkoutPaymentType === 'advance' ? (
                    <Text style={orderTabSt.demoPaySub}>Minimum 20% required to confirm. Pay balance before delivery.</Text>
                  ) : (
                    <Text style={orderTabSt.demoPaySub}>Test payment only. No real money will be charged.</Text>
                  )}
                </View>

                <TouchableOpacity style={[orderTabSt.payBtn, checkoutBusy && { opacity: 0.6 }]} activeOpacity={0.85} disabled={checkoutBusy} onPress={checkoutOffer ? payForOffer : payForRequestOrder}>
                  <Text style={orderTabSt.payBtnText}>{checkoutBusy ? 'Processing...' : `Pay Rs ${payNow}`}</Text>
                </TouchableOpacity>
              </>
            );
          })()}
        </View>
      </Modal>

      {screen === 'profile' ? (
        <>
          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.profileScrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshBuyerData} tintColor={C.mint} />}
          >
            <View style={profileSt.hero}>
              <TouchableOpacity style={profileSt.settingsBtn} activeOpacity={0.75}>
                <Text style={styles.settingsIcon}>⚙</Text>
              </TouchableOpacity>

              <View style={profileSt.avatar}>
                <Text style={profileSt.avatarText}>{buyerInitial}</Text>
              </View>
              <Text style={profileSt.name}>{buyerDisplayName}</Text>
              <Text style={profileSt.location}>Location: {location !== 'Set your location' ? location : (buyerProfile?.location || 'Set your location')}</Text>
              <Text style={profileSt.member}>{formatMemberSince(buyerProfile?.createdAt)}</Text>

              <TouchableOpacity style={profileSt.editBtn} activeOpacity={0.8}>
                <Text style={profileSt.editBtnText}>Edit Profile</Text>
              </TouchableOpacity>
            </View>

            <View style={profileSt.statsRow}>
              <StatBox num="18" label="Orders" />
              <View style={profileSt.divider} />
              <StatBox num="5" label="Requests" />
              <View style={profileSt.divider} />
              <StatBox num="4.8" label="Avg Rating" />
              <View style={profileSt.divider} />
              <StatBox num="₹4.2k" label="Spent" />
            </View>

            <View style={styles.sectionRow}>
              <Text style={styles.sectionHeading}>Recent Orders</Text>
            </View>

            {recentOrders.length === 0 ? (
              <View style={orderTabSt.emptyCard}>
                <Text style={orderTabSt.emptyEmoji}>📋</Text>
                <Text style={orderTabSt.emptyTitle}>No delivered orders yet</Text>
                <Text style={orderTabSt.emptySub}>Completed orders will appear here once chefs mark them delivered.</Text>
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentOrdersScroll}>
                {recentOrders.map((order) => (
                  <View key={order.id} style={styles.orderCardWrap}>
                    <RecentOrderCard item={order} onReorder={goRequest} />
                  </View>
                ))}
              </ScrollView>
            )}

            <View style={styles.sectionRow}>
              <Text style={styles.sectionHeading}>Saved Chefs</Text>
            </View>

            {!savedChefsReady || savedChefs.length === 0 ? (
              <View style={orderTabSt.emptyCard}>
                <Text style={orderTabSt.emptyEmoji}>💖</Text>
                <Text style={orderTabSt.emptyTitle}>{savedChefsReady ? 'No saved chefs yet' : 'Loading saved chefs...'}</Text>
                <Text style={orderTabSt.emptySub}>
                  {savedChefsReady
                    ? 'Tap the heart on any chef profile to keep them here for quick access.'
                    : 'Fetching your saved chefs.'}
                </Text>
              </View>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.savedChefsScroll}>
                {savedChefs.map((chef) => (
                  <TouchableOpacity key={chef.id} style={styles.savedChefCard} activeOpacity={0.85} onPress={() => goPublicChef(chef)}>
                    <View style={styles.savedChefAvatar}>
                      {chef.avatar ? (
                        <Image source={{ uri: chef.avatar }} style={styles.savedChefAvatarImage} resizeMode="cover" />
                      ) : (
                        <Text style={styles.savedChefAvatarText}>{chef.initial}</Text>
                      )}
                    </View>
                    <Text style={styles.savedChefName} numberOfLines={1}>{chef.name}</Text>
                    <Text style={styles.savedChefMeta} numberOfLines={1}>{chef.city ?? chef.distance}</Text>
                    <View style={styles.savedChefRatingPill}>
                      <Text style={styles.savedChefRatingText}>★ {chef.rating.toFixed(1)}</Text>
                    </View>
                    <Text style={styles.savedChefDish} numberOfLines={1}>{chef.dish}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            <View style={styles.notifRow}>
              <View style={styles.notifLeft}>
                <View style={[styles.menuIcon, { backgroundColor: C.paleGreen }]}>
                  <Text style={styles.menuIconText}>Bell</Text>
                </View>
                <View>
                  <Text style={styles.menuLabel}>Push Notifications</Text>
                  <Text style={styles.menuSub}>Quotes, order updates, offers</Text>
                </View>
              </View>
              <Switch value={notifEnabled} onValueChange={setNotifEnabled} trackColor={{ false: C.border, true: C.spice }} thumbColor={C.white} />
            </View>

            {profileMenuGroups.map((group) => (
              <View key={group.title} style={styles.menuGroup}>
                <Text style={styles.menuGroupTitle}>{group.title}</Text>
                {group.items.map((item) => (
                  <MenuItem key={`${group.title}-${item.label}`} item={item} />
                ))}
                {group.title === 'Account' ? (
                  <View style={styles.savedAddressesBlock}>
                    <Text style={styles.savedAddressesTitle}>Saved Addresses</Text>
                    {!savedAddressesReady ? (
                      <Text style={styles.savedAddressesHint}>Loading saved addresses...</Text>
                    ) : savedAddresses.length === 0 ? (
                      <Text style={styles.savedAddressesHint}>Save an address from the location picker to keep it here.</Text>
                    ) : (
                      savedAddresses.map((address) => (
                        <View key={address.id} style={styles.savedAddressCard}>
                          <View style={styles.savedAddressIconWrap}>
                            <Text style={styles.savedAddressIcon}>
                              {address.label.toLowerCase() === 'home' ? '⌂' : address.label.toLowerCase() === 'office' ? '▣' : '✎'}
                            </Text>
                          </View>
                          <View style={styles.savedAddressCopy}>
                            <Text style={styles.savedAddressLabel}>{address.label}</Text>
                            <Text style={styles.savedAddressText}>{address.address}</Text>
                          </View>
                        </View>
                      ))
                    )}
                  </View>
                ) : null}
              </View>
            ))}

            <View style={styles.chefBanner}>
              <View style={styles.chefBannerCopy}>
                <Text style={styles.chefBannerTitle}>Love to cook?</Text>
                <Text style={styles.chefBannerTitle}>Become a Chef</Text>
                <Text style={styles.chefBannerSub}>Earn from your kitchen on your own schedule</Text>
              </View>
              <TouchableOpacity style={styles.chefBannerBtn} activeOpacity={0.85} onPress={goChefProfile}>
                <Text style={styles.chefBannerBtnText}>Manage Profile</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.signOutBtn} activeOpacity={0.75} onPress={handleBuyerLogout}>
              <Text style={styles.signOutText}>Sign Out</Text>
            </TouchableOpacity>
          </ScrollView>

          <BottomNav active="profile" onHomePress={goHome} onExplorePress={goExplore} onRequestPress={goRequest} onOrdersPress={goOrders} onProfilePress={goProfile} />
        </>
      ) : null}

      <CounterModal
        visible={!!counterChef}
        chef={counterChef}
        currentBudget={quotesBudget}
        onClose={() => setCounterChef(null)}
        onSend={handleSendCounter}
      />

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ My Negotiations Modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {myOffers.filter((o) => o.status === 'COUNTERED').length > 0 ? (
        <Modal visible={!negSheetDismissed} transparent animationType="slide" onRequestClose={() => setNegSheetDismissed(true)}>
          <TouchableOpacity style={negSt.backdrop} activeOpacity={1} onPress={() => setNegSheetDismissed(true)} />
          <View style={negSt.sheet}>
            <View style={negSt.handle} />
            <Text style={negSt.title}>Chef Responded!</Text>
            <Text style={negSt.sub}>The chef has made a counter-offer. Respond below.</Text>
            {myOffers.filter((o) => o.status === 'COUNTERED').map((offer) => (
              <View key={offer.id} style={negSt.offerRow}>
                <View style={negSt.offerLeft}>
                  <Text style={negSt.offerEmoji}>{offer.dishEmoji}</Text>
                  <View>
                    <Text style={negSt.offerDish}>{offer.dishName}</Text>
                    <Text style={negSt.offerMeta}>{offer.plates} plate{offer.plates > 1 ? 's' : ''}</Text>
                  </View>
                </View>
                <View style={negSt.offerPrices}>
                  <Text style={negSt.offerYours}>Your: {'\u20B9'}{offer.offerPrice}</Text>
                  <Text style={negSt.arrow}>{'->'}</Text>
                  <Text style={negSt.offerChef}>Chef: {'\u20B9'}{offer.counterPrice}</Text>
                </View>
                {offer.counterNote ? <Text style={negSt.counterNote}>"{offer.counterNote}"</Text> : null}
                <View style={negSt.respondBtns}>
                  <TouchableOpacity
                    style={[negSt.respondBtn, negSt.respondAccept]}
                    onPress={async () => {
                      if (!buyerToken) return;
                      await fetch(`${API_BASE}/offers/${offer.id}/buyer-accept`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ buyerToken }),
                      });
                      await loadMyOffers(buyerToken);
                      goOrders();
                    }}
                  >
                    <Text style={negSt.respondAcceptText}>Hold @ {'\u20B9'}{offer.counterPrice}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[negSt.respondBtn, negSt.respondCounter]}
                    onPress={() => { setRespondOffer(offer); setRespondPrice(String(offer.offerPrice)); }}
                  >
                    <Text style={negSt.respondCounterText}>Counter</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[negSt.respondBtn, negSt.respondReject]}
                    onPress={async () => {
                      if (!buyerToken) return;
                      await fetch(`${API_BASE}/offers/${offer.id}/buyer-reject`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ buyerToken }),
                      });
                      loadMyOffers(buyerToken);
                    }}
                  >
                    <Text style={negSt.respondRejectText}>Reject</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        </Modal>
      ) : null}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Buyer counter-offer input modal ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      <Modal visible={respondOffer !== null} transparent animationType="fade">
        <KeyboardAvoidingView
          style={negSt.inputOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        >
          <View style={negSt.inputSheet}>
            <Text style={negSt.inputTitle}>Your Counter</Text>
            {respondOffer ? (
              <>
                <Text style={negSt.inputSub}>{respondOffer.dishEmoji} {respondOffer.dishName}</Text>
                <View style={negSt.lastCounterBanner}>
                  <Text style={negSt.lastCounterLabel}>CHEF'S PRICE</Text>
                  <Text style={negSt.lastCounterValue}>{'\u20B9'}{respondOffer.counterPrice}/plate</Text>
                  <Text style={negSt.lastCounterHint}>Your counter must be below this</Text>
                </View>
              </>
            ) : null}
            {(() => {
              const maxAllowed = respondOffer?.counterPrice ?? null;
              const entered = parseInt(respondPrice, 10);
              const tooHigh = maxAllowed !== null && !isNaN(entered) && entered >= maxAllowed;
              return (
                <>
                  <TextInput
                    style={[negSt.input, tooHigh && negSt.inputError]}
                    value={respondPrice}
                    onChangeText={setRespondPrice}
                    keyboardType="numeric"
                    placeholder={maxAllowed ? `Less than \u20B9${maxAllowed}` : 'Your price / plate'}
                    placeholderTextColor={C.warmGray}
                  />
                  {tooHigh ? (
                    <Text style={negSt.errorText}>Must be below {'\u20B9'}{maxAllowed}</Text>
                  ) : null}
                </>
              );
            })()}
            <View style={negSt.inputBtns}>
              <TouchableOpacity style={[negSt.inputBtn, negSt.inputBtnCancel]} onPress={() => setRespondOffer(null)}>
                <Text style={negSt.inputBtnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[negSt.inputBtn, negSt.inputBtnSend, respondBusy && { opacity: 0.6 }]}
                disabled={respondBusy}
                onPress={async () => {
                  if (!respondOffer || !buyerToken) return;
                  const price = parseInt(respondPrice, 10);
                  if (!price || price < 1) return;
                  if (respondOffer.counterPrice != null && price >= respondOffer.counterPrice) return;
                  setRespondBusy(true);
                  try {
                    await fetch(`${API_BASE}/offers/${respondOffer.id}/buyer-counter`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ buyerToken, newPrice: price }),
                    });
                    setRespondOffer(null);
                    loadMyOffers(buyerToken);
                  } finally {
                    setRespondBusy(false);
                  }
                }}
              >
                <Text style={negSt.inputBtnSendText}>{respondBusy ? 'Sending...' : 'Send Counter'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RequestFloatedScreen({
  dish,
  quoteCount,
  onViewQuotes,
  onHome,
  onCancel,
}: {
  dish: FloatedDish;
  quoteCount: number;
  onViewQuotes: () => void;
  onHome: () => void;
  onCancel: () => void;
}) {
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  const [dots, setDots] = useState('');

  useEffect(() => {
    const pulse = (anim: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ).start();
    };
    pulse(ring1, 0);
    pulse(ring2, 650);
    pulse(ring3, 1300);
  }, [ring1, ring2, ring3]);

  useEffect(() => {
    const timer = setInterval(() => setDots((d) => (d.length >= 3 ? '' : d + '.')), 500);
    return () => clearInterval(timer);
  }, []);

  const ringStyle = (anim: Animated.Value) => ({
    opacity: anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.55, 0.2, 0] }),
    transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
  });

  const spiceMap: Record<string, string> = { mild: 'Mild', medium: 'Medium', extra: 'Extra' };
  const deliveryMap: Record<string, string> = { pickup: 'Pickup', delivery: 'Delivery' };

  const foodEmoji = dish.emoji ?? '🍲';

  return (
    <>
      <View style={styles.postHeader}>
        <TouchableOpacity style={styles.backBtn} onPress={onHome} activeOpacity={0.75}>
          <Text style={styles.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Request Floated</Text>
        <View style={floatSt.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={floatSt.scroll}
      >
        {/* Hero: pulsing rings + emoji */}
        <View style={floatSt.heroWrap}>
          <View style={floatSt.pulseWrap}>
            <Animated.View style={[floatSt.ring, ringStyle(ring1)]} />
            <Animated.View style={[floatSt.ring, ringStyle(ring2)]} />
            <Animated.View style={[floatSt.ring, ringStyle(ring3)]} />
            <View style={floatSt.centerCircle}>
              <Text style={floatSt.centerEmoji}>{foodEmoji}</Text>
            </View>
          </View>
          <Text style={floatSt.title}>Request Floated!</Text>
          <Text style={floatSt.subtitle}>Notifying nearby chefs{dots}</Text>
        </View>

        {/* Request summary card */}
        <View style={floatSt.card}>
          <View style={floatSt.cardHeader}>
            <Text style={floatSt.cardHeaderEmoji}>{foodEmoji}</Text>
            <View style={floatSt.cardHeaderText}>
              <Text style={floatSt.cardDish}>{dish.dishName}</Text>
              <Text style={floatSt.cardDetails}>
                {(dish.quantityLabel ?? `${dish.qtyGrams} g`)} · serves {dish.servings} · {spiceMap[dish.spiceLevel] ?? dish.spiceLevel}
              </Text>
            </View>
          </View>
          {dish.servingNote ? <Text style={floatSt.cardNote}>{dish.servingNote}</Text> : null}
          <View style={floatSt.cardDivider} />
          <View style={floatSt.cardRow}>
            <View style={floatSt.cardTag}>
              <Text style={floatSt.cardTagText}>{deliveryMap[dish.delivery] ?? dish.delivery}</Text>
            </View>
            <Text style={floatSt.cardBudget}>Budget ₹{dish.budget}</Text>
          </View>
        </View>

        {/* Quote counter */}
        <View style={floatSt.counterCard}>
          <View style={floatSt.counterRow}>
            <Text style={floatSt.counterNum}>{quoteCount}</Text>
            <Text style={floatSt.counterChefIcon}>👨‍🍳</Text>
          </View>
          <Text style={floatSt.counterLabel}>
            {quoteCount === 0 ? 'Chefs are reviewing your request' : `Chef${quoteCount > 1 ? 's' : ''} sent a quote`}
          </Text>
          {quoteCount === 0 ? (
            <Text style={floatSt.counterHint}>Usually takes 5–15 minutes</Text>
          ) : null}
        </View>

        {/* CTA */}
        <TouchableOpacity
          style={[floatSt.viewBtn, quoteCount === 0 && floatSt.viewBtnWaiting]}
          activeOpacity={quoteCount === 0 ? 1 : 0.85}
          onPress={quoteCount > 0 ? onViewQuotes : undefined}
        >
          <Text style={[floatSt.viewBtnText, quoteCount === 0 && floatSt.viewBtnTextWaiting]}>
            {quoteCount === 0 ? 'Waiting for Quotes...' : `View ${quoteCount} Quote${quoteCount > 1 ? 's' : ''} →`}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={onCancel} activeOpacity={0.7} style={floatSt.cancelLink}>
          <Text style={floatSt.cancelText}>Cancel this request</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

function PublicChefProfileScreen({
  chef,
  onBack,
  onRequest,
  isSaved,
  onToggleSave,
}: {
  chef: PublicChef;
  onBack: () => void;
  onRequest: () => void;
  isSaved: boolean;
  onToggleSave: (chef: PublicChef, city?: string | null) => void;
}) {
  const MOCK_REVIEWS = [
    { id: '1', buyer: 'Amit S.', initial: 'A', rating: 5, comment: 'Absolutely delicious! Exactly what I wanted.', date: '2 days ago' },
    { id: '2', buyer: 'Ritu B.', initial: 'R', rating: 4, comment: 'Good food, slight delay but worth the wait.', date: '1 week ago' },
    { id: '3', buyer: 'Sona D.', initial: 'S', rating: 5, comment: 'Best home-cooked food in a long time!', date: '2 weeks ago' },
  ];
  const MOCK_GALLERY = ['Food', 'Dish', 'Bowl', 'Dessert', 'Meal', 'Noodles'];
  const OVEN_ITEMS = [
    { emoji: 'Dish', name: 'Mutton Kosha', etaMin: 50, price: 480, plates: 3, tags: ['Spicy', 'Bone-in'] },
    { emoji: 'Rice', name: 'Prawn Biryani', etaMin: 35, price: 390, plates: 5, tags: ['Seafood', 'Basmati'] },
    { emoji: 'Dal', name: 'Cholar Dal', etaMin: 20, price: 120, plates: 8, tags: ['Vegan', 'Light'] },
    { emoji: 'Dessert', name: 'Mishti Doi', etaMin: 10, price: 60, plates: 4, tags: ['Dessert', 'Bengali'] },
  ];

  const [profile, setProfile] = useState<PublicChefProfileApi | null>(null);
  const [liveDishes, setLiveDishes] = useState<CookingFeedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const startRef = useRef(Date.now());
  const [tick, setTick] = useState(0);

  // Kitchen image lightbox
  const [lightboxIdx, setLightboxIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const lightboxScrollRef = useRef<ScrollView>(null);
  const openLightbox = (idx: number) => {
    setLightboxIdx(idx);
    setLightboxOpen(true);
  };

  type BargainItem = { name: string; emoji: string; chefPrice: number; maxPlates: number };
  const [bargainItem, setBargainItem] = useState<BargainItem | null>(null);
  const [bargainOffer, setBargainOffer] = useState('');
  const [bargainPlates, setBargainPlates] = useState(1);
  const [bargainSent, setBargainSent] = useState<Record<string, number>>({});

  const openBargain = (item: BargainItem) => {
    setBargainOffer(String(Math.round(item.chefPrice * 0.9)));
    setBargainPlates(1);
    setBargainItem(item);
  };
  const sendOffer = () => {
    if (!bargainItem) return;
    const offer = parseInt(bargainOffer, 10);
    if (!offer || offer <= 0) return;
    setBargainSent((prev) => ({ ...prev, [bargainItem.name]: offer }));
    setBargainItem(null);
  };

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    const loadProfile = async () => {
      if (!chef.id) {
        setLoading(false);
        return;
      }
      try {
        const [profileRes, dishesRes] = await Promise.all([
          fetch(`${API_BASE}/users/${chef.id}`),
          fetch(`${API_BASE}/cooking?limit=50`),
        ]);
        const nextProfile = profileRes.ok ? await profileRes.json() as PublicChefProfileApi : null;
        const dishFeed = dishesRes.ok ? await dishesRes.json() as CookingFeedApiItem[] : [];
        if (!active) return;
        setProfile(nextProfile);
        setLiveDishes(dishFeed.map(mapCookingFeedItem).filter((item) => item.chefId === chef.id));
      } catch {
        if (!active) return;
        setProfile(null);
        setLiveDishes([]);
      } finally {
        if (active) setLoading(false);
      }
    };
    loadProfile();
    const intervalId = setInterval(loadProfile, 10000);
    return () => { active = false; clearInterval(intervalId); };
  }, [chef.id]);

  const timeLeft = (readyAt: string) => {
    const remaining = Math.floor((new Date(readyAt).getTime() - Date.now()) / 1000);
    if (remaining <= 0) return 'Ready now!';
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
  };

  const heroName = profile?.name ?? chef.name;
  const heroInitial = (profile?.name?.[0] ?? chef.initial).toUpperCase();
  const heroRating = profile?.rating ?? chef.rating;
  const heroReviewCount = profile?.ratingCount ?? profile?.reviewsReceived.length ?? 0;
  const heroMemberYear = new Date(profile?.createdAt ?? Date.now()).getFullYear();
  const sortedDishes = [...liveDishes].sort((a, b) => new Date(a.readyAt).getTime() - new Date(b.readyAt).getTime());
  const readyDishes = sortedDishes.filter((item) => item.status === 'ready' || new Date(item.readyAt).getTime() <= Date.now());
  const cookingDishes = sortedDishes.filter((item) => item.status !== 'ready' && new Date(item.readyAt).getTime() > Date.now());
  const featuredDish = readyDishes[0] ?? null;
  const extraReadyDishes = readyDishes.slice(1);
  const styleTags = Array.from(new Set([profile?.cookingStyle, ...liveDishes.flatMap((item) => item.tags.slice(0, 2))].filter(Boolean))) as string[];
  const reviewItems = profile?.reviewsReceived ?? [];


  return (
    <>
      {/* ═══ Bargain Modal ═══════════════════════════════════════ */}
      <Modal visible={!!bargainItem} transparent animationType="slide" onRequestClose={() => setBargainItem(null)}>
        <TouchableOpacity style={pubSt.bargainBackdrop} activeOpacity={1} onPress={() => setBargainItem(null)} />
        <KeyboardAvoidingView
          style={locSt.modalWrap}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
        >
        <View style={pubSt.bargainSheet}>
          <View style={pubSt.bargainHandle} />
          <View style={pubSt.bargainHeader}>
            <Text style={pubSt.bargainEmoji}>{bargainItem?.emoji}</Text>
            <View>
              <Text style={pubSt.bargainTitle}>Make an Offer</Text>
              <Text style={pubSt.bargainSub}>{bargainItem?.name}</Text>
            </View>
          </View>

          <View style={pubSt.bargainPriceRow}>
            <View style={pubSt.bargainPriceBox}>
              <Text style={pubSt.bargainPriceLabel}>Chef's Price</Text>
              <Text style={pubSt.bargainChefPrice}>₹{bargainItem?.chefPrice}</Text>
            </View>
            <Text style={pubSt.bargainArrow}>{'->'}</Text>
            <View style={[pubSt.bargainPriceBox, pubSt.bargainOfferBox]}>
              <Text style={pubSt.bargainPriceLabel}>Your Offer</Text>
              <View style={pubSt.bargainInputRow}>
                <Text style={pubSt.bargainRupee}>₹</Text>
                <TextInput
                  style={pubSt.bargainInput}
                  value={bargainOffer}
                  onChangeText={setBargainOffer}
                  keyboardType="numeric"
                  maxLength={6}
                  autoFocus
                />
              </View>
            </View>
          </View>

          {/* Quick presets */}
          {/* Plates selector */}
          <View style={pubSt.platesRow}>
            <Text style={pubSt.platesLabel}>No. of Plates</Text>
            <View style={pubSt.platesStepper}>
              <TouchableOpacity style={pubSt.platesBtn} onPress={() => setBargainPlates((p) => Math.max(1, p - 1))}>
                <Text style={pubSt.platesBtnText}>-</Text>
              </TouchableOpacity>
              <Text style={pubSt.platesCount}>{bargainPlates}</Text>
              <TouchableOpacity style={pubSt.platesBtn} onPress={() => setBargainPlates((p) => Math.min(bargainItem?.maxPlates ?? 1, p + 1))}>
                <Text style={pubSt.platesBtnText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={pubSt.platesTotal}>Max available: {bargainItem?.maxPlates ?? 0} plate{(bargainItem?.maxPlates ?? 0) !== 1 ? 's' : ''}</Text>

          <Text style={pubSt.bargainPresetsLabel}>Quick offers</Text>
          <View style={pubSt.bargainPresets}>
            {[10, 15, 20, 25].map((pct) => {
              const offerVal = Math.round((bargainItem?.chefPrice ?? 0) * (1 - pct / 100));
              return (
                <TouchableOpacity key={pct} style={[pubSt.bargainPreset, bargainOffer === String(offerVal) && pubSt.bargainPresetActive]} activeOpacity={0.75} onPress={() => setBargainOffer(String(offerVal))}>
                  <Text style={[pubSt.bargainPresetPct, bargainOffer === String(offerVal) && pubSt.bargainPresetPctActive]}>{pct}% off</Text>
                  <Text style={[pubSt.bargainPresetAmt, bargainOffer === String(offerVal) && pubSt.bargainPresetAmtActive]}>₹{offerVal}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity style={pubSt.bargainSendBtn} activeOpacity={0.85} onPress={sendOffer}>
            <Text style={pubSt.bargainSendText}>Send Offer · ₹{(parseInt(bargainOffer) || 0) * bargainPlates} ({bargainPlates} plate{bargainPlates > 1 ? 's' : ''})</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={pubSt.bargainAcceptBtn}
            activeOpacity={0.85}
            onPress={() => {
              setBargainSent((prev) => ({ ...prev, [bargainItem!.name]: bargainItem!.chefPrice }));
              setBargainItem(null);
            }}
          >
            <Text style={pubSt.bargainAcceptText}>Accept at Chef's Price · ₹{(bargainItem?.chefPrice ?? 0) * bargainPlates} ({bargainPlates} plate{bargainPlates > 1 ? 's' : ''})</Text>
          </TouchableOpacity>
          <Text style={pubSt.bargainNote}>Chef will accept, counter, or decline your offer.</Text>
        </View>
        </KeyboardAvoidingView>
      </Modal>

      <View style={styles.postHeader}>
        <TouchableOpacity style={styles.backBtn} activeOpacity={0.75} onPress={onBack}>
          <Text style={styles.backIcon}>{'←'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Chef Profile</Text>
        <TouchableOpacity
          style={[pubSt.saveChefBtn, isSaved && pubSt.saveChefBtnActive]}
          activeOpacity={0.8}
          onPress={() => onToggleSave(chef, profile?.city)}
        >
          <Text style={pubSt.saveChefEmoji}>{isSaved ? '💖' : '🤍'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Hero */}
        <View style={pubSt.hero}>
          <View style={pubSt.heroCover}>
            {profile?.coverImage ? <Image source={{ uri: profile.coverImage }} style={pubSt.heroCoverImage} resizeMode="cover" /> : null}
            <View style={pubSt.heroCoverOverlay} />
          </View>
          <View style={pubSt.heroContent}>
            <View style={pubSt.avatarWrap}>
              <View style={pubSt.avatar}>
                {profile?.avatar ? (
                  <Image source={{ uri: profile.avatar }} style={pubSt.avatarImage} resizeMode="cover" />
                ) : (
                  <Text style={pubSt.avatarText}>{heroInitial}</Text>
                )}
              </View>
              <View style={pubSt.onlineDot} />
            </View>
            <Text style={pubSt.name}>{heroName}</Text>
            <Text style={pubSt.distBadge}>Location: {profile?.city ?? `${chef.distance}${profile?.city ? '' : ' away'}`}</Text>
            <View style={pubSt.ratingRow}>
              <Text style={pubSt.star}>★</Text>
              <Text style={pubSt.ratingVal}>{heroRating}</Text>
              <Text style={pubSt.ratingCount}>({heroReviewCount} reviews)</Text>
            </View>
            {profile?.bio ? <Text style={pubSt.bioText}>{profile.bio}</Text> : null}
            {loading ? <Text style={pubSt.bioText}>Loading chef profile...</Text> : null}
          </View>
        </View>

        {/* Stats */}
        <View style={pubSt.statsRow}>
          {[
            { num: `★ ${heroRating}`, label: 'Rating', bg: C.paleYellow, numColor: C.turmeric },
            { num: String(profile?.totalOrders ?? liveDishes.length), label: 'Orders', bg: C.blush, numColor: C.spice },
            { num: '~20m', label: 'Response', bg: C.paleGreen, numColor: C.mint },
            { num: String(heroMemberYear), label: 'Member', bg: C.paleBlue, numColor: '#4F6CF5' },
          ].map((s) => (
            <View key={s.label} style={[pubSt.statItem, { backgroundColor: s.bg }]}>
              <Text style={[pubSt.statNum, { color: s.numColor }]}>{s.num}</Text>
              <Text style={pubSt.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Now cooking */}
        <View style={pubSt.section}>
          <Text style={pubSt.sectionTitle}>Serving Hot</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={pubSt.hotScroll}>
            {featuredDish ? (
            <TouchableOpacity style={pubSt.hotCard} activeOpacity={0.85}>
              <View style={[pubSt.hotImgBox, !featuredDish.imageUri && pubSt.hotImgPlaceholder]}>
                {featuredDish.imageUri ? (
                  <Image source={{ uri: featuredDish.imageUri }} style={pubSt.hotImgPhoto} />
                ) : (
                  <Text style={pubSt.hotImgEmoji}>{featuredDish.emoji}</Text>
                )}
                <View style={pubSt.hotBadge}><Text style={pubSt.hotBadgeText}>Live</Text></View>
              </View>
              <Text style={pubSt.hotDish}>{featuredDish.dish}</Text>
              <View style={pubSt.hotPriceRow}>
                  <Text style={pubSt.hotEta}>₹{featuredDish?.price ?? chef.price}</Text>
                <View style={pubSt.hotPlatesBadge}>
                    <Text style={pubSt.hotPlatesText}>{featuredDish?.serves ?? chef.serves} plates</Text>
                </View>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={pubSt.hotTagRow}>
                {featuredDish.tags.map((t) => (
                  <View key={t} style={pubSt.hotTag}><Text style={pubSt.hotTagText}>{t}</Text></View>
                ))}
              </ScrollView>
              {bargainSent[featuredDish.dish] ? (
                <View style={pubSt.bargainSentPill}>
                  <Text style={pubSt.bargainSentText}>Offer ₹{bargainSent[featuredDish?.dish ?? chef.dish]} sent</Text>
                </View>
              ) : (
                <TouchableOpacity style={pubSt.bargainBtn} activeOpacity={0.8} onPress={() => openBargain({ name: featuredDish?.dish ?? chef.dish, emoji: featuredDish?.emoji ?? 'Dish', chefPrice: featuredDish?.price ?? chef.price, maxPlates: featuredDish?.serves ?? chef.serves })}>
                  <Text style={pubSt.bargainBtnText}>Order Now</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
            ) : (
              <View style={pubSt.emptyCard}>
                <Text style={pubSt.emptyTitle}>Nothing is live yet</Text>
                <Text style={pubSt.emptyText}>This chef still has dishes cooking. Check the countdown cards below.</Text>
              </View>
            )}

            {/* Other ready foods */}
            {extraReadyDishes.map((item) => (
              <TouchableOpacity key={item.id} style={pubSt.hotCard} activeOpacity={0.85}>
                <View style={[pubSt.hotImgBox, !item.imageUri && pubSt.hotImgPlaceholder]}>
                  {item.imageUri ? (
                    <Image source={{ uri: item.imageUri }} style={pubSt.hotImgPhoto} />
                  ) : (
                    <Text style={pubSt.hotImgEmoji}>{item.emoji}</Text>
                  )}
                </View>
                <Text style={pubSt.hotDish}>{item.dish}</Text>
                <View style={pubSt.hotPriceRow}>
                  <Text style={pubSt.hotEta}>₹{item.price}</Text>
                  <View style={pubSt.hotPlatesBadge}>
                    <Text style={pubSt.hotPlatesText}>Plates {item.serves}</Text>
                  </View>
                </View>
                <View style={pubSt.hotTagRow}>
                  {item.tags.map((t) => (
                    <View key={t} style={pubSt.hotTag}><Text style={pubSt.hotTagText}>{t}</Text></View>
                  ))}
                </View>
                {bargainSent[item.dish] ? (
                  <View style={pubSt.bargainSentPill}>
                    <Text style={pubSt.bargainSentText}>Offer ₹{bargainSent[item.dish]} sent</Text>
                  </View>
                ) : (
                  <TouchableOpacity style={pubSt.bargainBtn} activeOpacity={0.8} onPress={() => openBargain({ name: item.dish, emoji: item.emoji, chefPrice: item.price, maxPlates: item.serves })}>
                    <Text style={pubSt.bargainBtnText}>Order Now</Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Also in the oven */}
        <View style={pubSt.section}>
          <Text style={pubSt.sectionTitle}>Hot & Ready Soon</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={pubSt.alsoScroll}>
            {cookingDishes.length > 0 ? cookingDishes.map((item) => (
              <TouchableOpacity key={item.id} style={pubSt.alsoCard} activeOpacity={0.82}>
                <Text style={pubSt.alsoEmoji}>{item.emoji}</Text>
                <Text style={pubSt.alsoName}>{item.dish}</Text>
                <View style={pubSt.alsoCountdown}>
                  <Text style={pubSt.alsoCountdownText}>ETA {timeLeft(item.readyAt)}</Text>
                </View>
                <View style={pubSt.alsoTagRow}>
                  {item.tags.map((t) => (
                    <View key={t} style={pubSt.alsoTag}>
                      <Text style={pubSt.alsoTagText}>{t}</Text>
                    </View>
                  ))}
                </View>
                <Text style={pubSt.alsoPrice}>₹{item.price}</Text>
                {bargainSent[item.dish] ? (
                  <View style={pubSt.bargainSentPill}>
                    <Text style={pubSt.bargainSentText}>Offer ₹{bargainSent[item.dish]} sent</Text>
                  </View>
                ) : (
                  <TouchableOpacity style={[pubSt.bargainBtn, pubSt.preOrderBtn]} activeOpacity={0.8} onPress={() => openBargain({ name: item.dish, emoji: item.emoji, chefPrice: item.price, maxPlates: item.serves })}>
                    <Text style={pubSt.bargainBtnText}>Pre-Order</Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            )) : (
              <View style={pubSt.emptyCard}>
                <Text style={pubSt.emptyTitle}>No active cooking right now</Text>
                <Text style={pubSt.emptyText}>This chef has no dishes currently counting down.</Text>
              </View>
            )}
          </ScrollView>
        </View>

        {/* Culinary style chips */}
        <View style={pubSt.section}>
          <Text style={pubSt.sectionTitle}>Culinary Style</Text>
          <View style={styles.tagsRow}>
            {(styleTags.length > 0 ? styleTags : ['Bengali', 'Home-style', 'Spicy', 'Non-Veg']).map((tag) => (
              <View key={tag} style={pubSt.styleChip}>
                <Text style={pubSt.styleChipText}>{tag}</Text>
              </View>
            ))}
          </View>
        </View>

        {(profile?.specialityDishes ?? []).length > 0 ? (
          <View style={pubSt.section}>
            <Text style={pubSt.sectionTitle}>Signature Dishes</Text>
            <View style={pubSt.signatureList}>
              {(profile?.specialityDishes ?? []).map((dish) => (
                <View key={dish.dishName} style={pubSt.signatureCard}>
                  <Image source={{ uri: dish.imageUrl }} style={pubSt.signatureImage} />
                  <View style={pubSt.signatureBody}>
                    <Text style={pubSt.signatureName}>{dish.dishName}</Text>
                    {dish.ratingCount > 0 ? (
                      <Text style={pubSt.signatureRating}>★ {dish.ratingAverage.toFixed(1)} · {dish.ratingCount} review{dish.ratingCount > 1 ? 's' : ''}</Text>
                    ) : null}
                    <Text style={pubSt.signatureDesc} numberOfLines={2}>{dish.description}</Text>
                    {dish.recentReviews[0]?.comment ? (
                      <Text style={pubSt.signatureQuote} numberOfLines={1}>"{dish.recentReviews[0].comment}"</Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Kitchen gallery */}
        {(profile?.kitchenImages ?? []).length > 0 ? (
          <View style={pubSt.section}>
            <Text style={pubSt.sectionTitle}>Kitchen Gallery</Text>
            <View style={pubSt.gallery}>
              {(profile!.kitchenImages!).map((uri, i) => (
                <TouchableOpacity key={i} style={pubSt.galleryItem} activeOpacity={0.85} onPress={() => openLightbox(i)}>
                  <Image source={{ uri }} style={pubSt.galleryPhoto} resizeMode="cover" />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        {/* Reviews */}
        <View style={pubSt.section}>
          <Text style={pubSt.sectionTitle}>Reviews</Text>
          {(reviewItems.length > 0 ? reviewItems.map((review, index) => ({ id: review.id, initial: review.buyerName?.[0]?.toUpperCase() ?? String(index + 1), buyer: review.buyerName, date: new Date(review.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }), rating: review.rating, comment: review.comment })) : MOCK_REVIEWS).map((r) => (
            <View key={r.id} style={pubSt.reviewCard}>
              <View style={pubSt.reviewTop}>
                <View style={pubSt.reviewAv}>
                  <Text style={pubSt.reviewAvText}>{r.initial}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={pubSt.reviewName}>{r.buyer}</Text>
                  <Text style={pubSt.reviewDate}>{r.date}</Text>
                </View>
                <Text style={pubSt.reviewStars}>{'★'.repeat(r.rating)}</Text>
              </View>
              <Text style={pubSt.reviewComment}>{r.comment}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* CTA */}
      <View style={pubSt.cta}>
        <TouchableOpacity style={pubSt.ctaBtn} activeOpacity={0.85} onPress={onRequest}>
          <Text style={pubSt.ctaBtnText}>Post a Request for {heroName.split(' ')[0]} →</Text>
        </TouchableOpacity>
      </View>

      {/* Kitchen image lightbox — floating popup */}
      <Modal visible={lightboxOpen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setLightboxOpen(false)}>
        {/* Tap backdrop to close */}
        <TouchableOpacity style={pubSt.lbBackdrop} activeOpacity={1} onPress={() => setLightboxOpen(false)}>
          {/* Inner card — stop propagation so tapping card doesn't close */}
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={pubSt.lbCard}>
            {/* Counter + close row */}
            <View style={pubSt.lbTopRow}>
              <Text style={pubSt.lbCounter}>{lightboxIdx + 1} / {(profile?.kitchenImages ?? []).length}</Text>
              <TouchableOpacity onPress={() => setLightboxOpen(false)} activeOpacity={0.8} style={pubSt.lbCloseBtn}>
                <Text style={pubSt.lbCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            {/* Paged image slider */}
            <ScrollView
              ref={lightboxScrollRef}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onLayout={() => {
                lightboxScrollRef.current?.scrollTo({ x: lightboxIdx * (SCREEN_W - 48), animated: false });
              }}
              onMomentumScrollEnd={(e) => {
                const idx = Math.round(e.nativeEvent.contentOffset.x / (SCREEN_W - 48));
                setLightboxIdx(idx);
              }}
              style={pubSt.lbScroll}
            >
              {(profile?.kitchenImages ?? []).map((uri, i) => (
                <View key={i} style={pubSt.lbPage}>
                  <Image source={{ uri }} style={pubSt.lbImage} resizeMode="cover" />
                </View>
              ))}
            </ScrollView>
            {/* Dot indicators */}
            {(profile?.kitchenImages ?? []).length > 1 ? (
              <View style={pubSt.lbDots}>
                {(profile!.kitchenImages!).map((_, i) => (
                  <View key={i} style={[pubSt.lbDot, i === lightboxIdx && pubSt.lbDotActive]} />
                ))}
              </View>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const pubSt = StyleSheet.create({
  saveChefBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.white,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveChefBtnActive: {
    backgroundColor: '#FFF0F4',
    borderColor: '#F5C8D4',
  },
  saveChefEmoji: { fontSize: 20 },
  hero: { backgroundColor: C.cream, borderBottomWidth: 1, borderBottomColor: C.border, overflow: 'hidden' },
  heroCover: { height: 164, backgroundColor: '#F5E8DB' },
  heroCoverImage: { width: '100%', height: '100%' },
  heroCoverOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(26,18,9,0.14)' },
  heroContent: { alignItems: 'center', paddingHorizontal: 20, paddingBottom: 24, marginTop: -44 },
  avatarWrap: { position: 'relative', marginBottom: 12 },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: C.spice, alignItems: 'center', justifyContent: 'center', shadowColor: C.spice, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 14, elevation: 5, borderWidth: 4, borderColor: C.white, overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { fontSize: 34, color: C.white, fontWeight: '900' },
  onlineDot: { position: 'absolute', bottom: 4, right: 4, width: 16, height: 16, borderRadius: 8, backgroundColor: '#22C55E', borderWidth: 2.5, borderColor: C.white },
  name: { fontSize: 22, fontWeight: '900', color: C.ink, marginBottom: 4, letterSpacing: -0.4 },
  distBadge: { fontSize: 12, color: C.warmGray, marginBottom: 10 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  star: { fontSize: 15, color: C.turmeric },
  ratingVal: { fontSize: 15, fontWeight: '800', color: C.ink },
  ratingCount: { fontSize: 12, color: C.warmGray },
  bioText: { fontSize: 13, color: C.warmGray, textAlign: 'center', marginTop: 10, lineHeight: 19, paddingHorizontal: 10 },
  statsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.border },
  statItem: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 16 },
  statDivider: {},
  statNum: { fontSize: 13, fontWeight: '900', color: C.ink, letterSpacing: -0.3 },
  statLabel: { fontSize: 10, color: C.warmGray, marginTop: 3, fontWeight: '700' },
  section: { paddingHorizontal: 18, paddingTop: 22 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: C.ink, marginBottom: 12, letterSpacing: -0.2 },
  hotScroll: { gap: 10, paddingBottom: 6, paddingRight: 18 },
  hotCard: { width: 170, backgroundColor: C.white, borderRadius: 18, padding: 12, gap: 6, borderWidth: 1, borderColor: C.border, shadowColor: 'rgba(26,18,9,0.07)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 10, elevation: 2 },
  hotImgBox: { width: '100%', height: 108, borderRadius: 12, backgroundColor: '#FDDDB8', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 2, position: 'relative' },
  hotImgPlaceholder: { backgroundColor: '#F0EBE3' },
  hotImgEmoji: { fontSize: 36 },
  hotImgPhoto: { width: '100%', height: '100%' },
  hotBadge: { position: 'absolute', bottom: 6, left: 6, backgroundColor: C.spice, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  hotBadgeText: { fontSize: 9, color: C.white, fontWeight: '800' },
  hotDish: { fontSize: 14, fontWeight: '800', color: C.ink },
  hotPriceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hotEta: { fontSize: 15, fontWeight: '900', color: C.ink, letterSpacing: -0.3 },
  hotPlatesBadge: { backgroundColor: C.paleBlue, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  hotPlatesText: { fontSize: 10, color: '#4F6CF5', fontWeight: '600' },
  hotTagRow: { flexDirection: 'row', gap: 4 },
  hotTag: { backgroundColor: '#FDE8DC', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  hotTagText: { fontSize: 10, color: C.spice, fontWeight: '600' },
  bargainBtn: { backgroundColor: C.mint, borderRadius: 12, paddingVertical: 9, alignItems: 'center', marginTop: 4 },
  preOrderBtn: { backgroundColor: '#7C3AED' },
  bargainBtnText: { color: C.white, fontSize: 12, fontWeight: '700' },
  bargainSentPill: { backgroundColor: C.paleGreen, borderRadius: 8, paddingVertical: 6, alignItems: 'center', marginTop: 2 },
  bargainSentText: { fontSize: 11, color: C.mint, fontWeight: '700' },
  bargainBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  bargainSheet: { backgroundColor: C.white, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 22, paddingBottom: 36 },
  bargainHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginBottom: 18 },
  bargainHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  bargainEmoji: { fontSize: 32 },
  bargainTitle: { fontSize: 17, fontWeight: '800', color: C.ink },
  bargainSub: { fontSize: 13, color: C.warmGray, marginTop: 2 },
  bargainPriceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  bargainPriceBox: { flex: 1, backgroundColor: '#F5F2ED', borderRadius: 12, padding: 14, alignItems: 'center' },
  bargainOfferBox: { backgroundColor: C.paleGreen, borderWidth: 2, borderColor: C.mint },
  bargainPriceLabel: { fontSize: 11, color: C.warmGray, fontWeight: '600', marginBottom: 4 },
  bargainChefPrice: { fontSize: 20, fontWeight: '800', color: C.ink },
  bargainArrow: { fontSize: 20, color: C.warmGray },
  bargainInputRow: { flexDirection: 'row', alignItems: 'center' },
  bargainRupee: { fontSize: 18, fontWeight: '800', color: C.mint, marginRight: 2 },
  bargainInput: { fontSize: 22, fontWeight: '800', color: C.mint, minWidth: 70, textAlign: 'center', padding: 0 },
  bargainPresetsLabel: { fontSize: 12, color: C.warmGray, fontWeight: '600', marginBottom: 10 },
  bargainPresets: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  bargainPreset: { flex: 1, backgroundColor: '#F5F2ED', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1.5, borderColor: 'transparent' },
  bargainPresetActive: { backgroundColor: C.paleGreen, borderColor: C.mint },
  bargainPresetPct: { fontSize: 12, fontWeight: '700', color: C.ink },
  bargainPresetPctActive: { color: C.mint },
  bargainPresetAmt: { fontSize: 11, color: C.warmGray, marginTop: 2 },
  bargainPresetAmtActive: { color: C.mint },
  bargainContactRow: { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 12 },
  bargainContactInput: { backgroundColor: '#F5F2ED', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, color: '#1A1209', borderWidth: 1, borderColor: '#EDE8E0' },
  bargainSendBtn: { backgroundColor: C.spice, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginBottom: 10 },
  bargainSendText: { color: C.white, fontSize: 15, fontWeight: '800' },
  bargainAcceptBtn: { backgroundColor: C.mint, borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginBottom: 12 },
  bargainAcceptText: { color: C.white, fontSize: 15, fontWeight: '800' },
  bargainNote: { textAlign: 'center', fontSize: 12, color: C.warmGray },
  platesRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F2ED', borderRadius: 12, padding: 12, marginBottom: 16, gap: 10 },
  platesLabel: { fontSize: 13, fontWeight: '600', color: C.ink, flex: 1 },
  platesStepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  platesBtn: { width: 32, height: 32, borderRadius: 10, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  platesBtnText: { fontSize: 18, fontWeight: '700', color: C.ink, lineHeight: 22 },
  platesCount: { fontSize: 18, fontWeight: '800', color: C.ink, minWidth: 24, textAlign: 'center' },
  platesTotal: { fontSize: 13, fontWeight: '700', color: C.mint },
  alsoScroll: { paddingBottom: 4, gap: 10 },
  alsoCard: { width: 154, backgroundColor: C.white, borderRadius: 18, padding: 12, borderWidth: 1, borderColor: C.border, gap: 4, shadowColor: 'rgba(26,18,9,0.07)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 8, elevation: 1 },
  alsoCountdown: { backgroundColor: '#FEF3E2', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' },
  alsoCountdownReady: { backgroundColor: C.paleGreen },
  alsoCountdownText: { fontSize: 11, fontWeight: '700', color: '#B07800' },
  alsoCountdownTextReady: { color: C.mint },
  alsoEmoji: { fontSize: 28, marginBottom: 2 },
  alsoName: { fontSize: 13, fontWeight: '700', color: C.ink },
  alsoEta: { fontSize: 11, color: C.warmGray },
  alsoTagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 },
  alsoTag: { backgroundColor: C.paleYellow, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  alsoTagText: { fontSize: 10, color: '#B07800', fontWeight: '600' },
  alsoPrice: { fontSize: 15, fontWeight: '900', color: C.ink, marginTop: 4, letterSpacing: -0.3 },
  emptyCard: { width: 220, backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 16, justifyContent: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 6 },
  emptyText: { fontSize: 12, color: C.warmGray, lineHeight: 18 },
  styleChip: { backgroundColor: C.paleGreen, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5 },
  styleChipText: { fontSize: 12, color: C.mint, fontWeight: '600' },
  signatureList: { gap: 10 },
  signatureCard: { flexDirection: 'row', backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  signatureImage: { width: 84, height: 84, backgroundColor: C.border },
  signatureBody: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
  signatureName: { fontSize: 14, fontWeight: '800', color: C.ink, marginBottom: 4 },
  signatureRating: { fontSize: 11, color: C.spice, fontWeight: '700', marginBottom: 4 },
  signatureDesc: { fontSize: 12, color: C.ink, lineHeight: 17, marginBottom: 4 },
  signatureQuote: { fontSize: 11, color: C.warmGray, fontStyle: 'italic' },
  gallery: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  galleryItem: { width: (SCREEN_W - 52) / 3, aspectRatio: 1, backgroundColor: C.border, borderRadius: 10, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  galleryPhoto: { width: '100%', height: '100%', borderRadius: 10 },
  galleryEmoji: { fontSize: 32 },

  // Lightbox ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â floating popup
  // Lightbox — floating popup
  lbBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 },
  lbCard: { width: SCREEN_W - 48, maxWidth: 420, maxHeight: '84%', backgroundColor: '#111', borderRadius: 20, overflow: 'hidden' },
  lbTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12 },
  lbCounter: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.6)' },
  lbCloseBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  lbCloseText: { color: '#fff', fontSize: 13, fontWeight: '800', lineHeight: 15 },
  lbScroll: { width: SCREEN_W - 48 },
  lbPage: { width: SCREEN_W - 48, height: SCREEN_W - 48, overflow: 'hidden' },
  lbImage: { width: SCREEN_W - 48, height: SCREEN_W - 48 },
  lbDots: { flexDirection: 'row', gap: 5, justifyContent: 'center', paddingVertical: 12 },
  lbDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  lbDotActive: { backgroundColor: '#fff', width: 16 },
  reviewCard: { backgroundColor: C.white, borderRadius: 18, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: C.border, shadowColor: 'rgba(26,18,9,0.05)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 8, elevation: 1 },
  reviewTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  reviewAv: { width: 38, height: 38, borderRadius: 19, backgroundColor: C.blush, alignItems: 'center', justifyContent: 'center' },
  reviewAvText: { fontSize: 15, fontWeight: '800', color: C.spice },
  reviewName: { fontSize: 13, fontWeight: '800', color: C.ink },
  reviewDate: { fontSize: 11, color: C.warmGray, marginTop: 1 },
  reviewStars: { fontSize: 13, color: C.turmeric },
  reviewComment: { fontSize: 13, color: C.ink, lineHeight: 20 },
  cta: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 28, backgroundColor: C.white, borderTopWidth: 1, borderTopColor: C.border },
  ctaBtn: { backgroundColor: C.spice, borderRadius: 18, paddingVertical: 17, alignItems: 'center', shadowColor: C.spice, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.28, shadowRadius: 12, elevation: 4 },
  ctaBtnText: { color: C.white, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
});

const floatSt = StyleSheet.create({
  headerSpacer: { width: 40 },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 60, alignItems: 'center' },

  // Hero
  heroWrap: { alignItems: 'center', marginBottom: 24 },
  pulseWrap: { width: 148, height: 148, alignItems: 'center', justifyContent: 'center', marginTop: 24, marginBottom: 18 },
  ring: { position: 'absolute', width: 96, height: 96, borderRadius: 48, backgroundColor: C.spice },
  centerCircle: { width: 84, height: 84, borderRadius: 42, backgroundColor: C.blush, alignItems: 'center', justifyContent: 'center', borderWidth: 2.5, borderColor: 'rgba(232,93,38,0.18)' },
  centerEmoji: { fontSize: 40 },
  title: { fontSize: 26, fontWeight: '800', color: C.ink, textAlign: 'center', letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: C.warmGray, textAlign: 'center', marginTop: 6, minWidth: 220 },

  // Summary card
  card: { width: '100%', backgroundColor: C.white, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 14, shadowColor: C.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10 },
  cardHeaderEmoji: { fontSize: 30, width: 46, textAlign: 'center', lineHeight: 42 },
  cardHeaderText: { flex: 1 },
  cardDish: { fontSize: 17, fontWeight: '800', color: C.ink, marginBottom: 3, letterSpacing: -0.3 },
  cardDetails: { fontSize: 13, color: C.warmGray, lineHeight: 18 },
  cardNote: { fontSize: 12, color: C.warmGray, marginBottom: 10, paddingLeft: 58, lineHeight: 17 },
  cardDivider: { height: 1, backgroundColor: C.border, marginBottom: 12 },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTag: { backgroundColor: C.paleGreen, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: '#C3E6D3' },
  cardTagText: { fontSize: 12, color: C.mint, fontWeight: '700' },
  cardBudget: { fontSize: 16, fontWeight: '800', color: C.ink },

  // Counter card
  counterCard: { width: '100%', backgroundColor: C.paleGreen, borderRadius: 20, paddingVertical: 22, paddingHorizontal: 20, alignItems: 'center', marginBottom: 20, borderWidth: 1, borderColor: '#C3E6D3' },
  counterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  counterNum: { fontSize: 56, fontWeight: '800', color: C.ink, lineHeight: 60 },
  counterChefIcon: { fontSize: 28 },
  counterLabel: { fontSize: 14, color: '#2E7D5E', fontWeight: '600', textAlign: 'center' },
  counterHint: { fontSize: 12, color: C.warmGray, marginTop: 6, textAlign: 'center' },

  // CTA
  viewBtn: { width: '100%', backgroundColor: C.mint, borderRadius: 18, paddingVertical: 17, alignItems: 'center', marginBottom: 16, shadowColor: C.mint, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 4 },
  viewBtnWaiting: { backgroundColor: C.border, shadowOpacity: 0, elevation: 0 },
  viewBtnText: { fontSize: 16, fontWeight: '800', color: C.white, letterSpacing: 0.2 },
  viewBtnTextWaiting: { color: C.warmGray, fontWeight: '600' },
  cancelLink: { paddingVertical: 10 },
  cancelText: { fontSize: 13, color: C.warmGray, textDecorationLine: 'underline' },
});

function ChefProfileScreen({ onBack }: { onBack: () => void }) {
  const [isAvailable, setIsAvailable] = useState(true);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [kitchenUris, setKitchenUris] = useState<string[]>([]);
  const [bio, setBio] = useState(CHEF_PROFILE.bio);
  const [editingBio, setEditingBio] = useState(false);
  const [culinaryStyles, setCulinaryStyles] = useState(CHEF_PROFILE.culinaryStyles);

  const pickImage = async (
    aspect: [number, number],
    onPick: (uri: string) => void,
  ) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect,
      quality: 0.85,
    });
    if (!result.canceled) onPick(result.assets[0].uri);
  };

  const removeStyle = (style: string) =>
    setCulinaryStyles((prev) => prev.filter((s) => s !== style));

  const IMG_SIZE = (SCREEN_W - 36 - 16) / 3;

  return (
    <>
      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Header ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      <View style={styles.postHeader}>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.75}>
          <Text style={styles.backIcon}>ÃƒÂ¢Ã¢â‚¬Â Ã‚Â</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Chef Profile</Text>
        <TouchableOpacity style={chefSt.saveBtn} activeOpacity={0.85}>
          <Text style={chefSt.saveBtnText}>Save</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Cover / Kitchen Photo ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <TouchableOpacity
          style={chefSt.cover}
          activeOpacity={0.88}
          onPress={() => pickImage([16, 9], setCoverUri)}
        >
          {coverUri ? (
            <Image source={{ uri: coverUri }} style={chefSt.coverImg} />
          ) : (
            <View style={chefSt.coverPlaceholder}>
              <Text style={chefSt.coverIcon}>ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â·</Text>
              <Text style={chefSt.coverLabel}>Add Kitchen Photo</Text>
              <Text style={chefSt.coverSub}>Show buyers your cooking space</Text>
            </View>
          )}
          <View style={chefSt.coverBadge}>
            <Text style={chefSt.coverBadgeText}>ÃƒÂ¢Ã…â€œÃ‚ÂÃƒÂ¯Ã‚Â¸Ã‚Â  Change Cover</Text>
          </View>
        </TouchableOpacity>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Avatar + Info ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.heroRow}>
          <View>
            <View style={chefSt.avatar}>
              <Text style={chefSt.avatarText}>{CHEF_PROFILE.initial}</Text>
            </View>
            <TouchableOpacity style={chefSt.avatarCam} activeOpacity={0.8}>
              <Text style={{ fontSize: 10 }}>ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â·</Text>
            </TouchableOpacity>
          </View>
          <View style={chefSt.heroInfo}>
            <Text style={chefSt.heroName}>{CHEF_PROFILE.name}</Text>
            <Text style={chefSt.heroLoc}>ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â {CHEF_PROFILE.location}</Text>
            <View style={chefSt.heroMetaRow}>
              <Text style={chefSt.heroStar}>ÃƒÂ¢Ã‚Â­Ã‚Â {CHEF_PROFILE.rating}</Text>
              <Text style={chefSt.heroDot}>Ãƒâ€šÃ‚Â·</Text>
              <Text style={chefSt.heroMeta}>{CHEF_PROFILE.orders} orders</Text>
              <Text style={chefSt.heroDot}>Ãƒâ€šÃ‚Â·</Text>
              <Text style={chefSt.heroMeta}>Since {CHEF_PROFILE.since}</Text>
            </View>
          </View>
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Availability toggle ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.availRow}>
          <View style={chefSt.availLeft}>
            <View style={[chefSt.availDot, { backgroundColor: isAvailable ? C.mint : C.warmGray }]} />
            <View>
              <Text style={chefSt.availTitle}>{isAvailable ? 'Taking Orders' : 'Unavailable'}</Text>
              <Text style={chefSt.availSub}>
                {isAvailable ? 'Buyers can send you requests' : "You won't receive new requests"}
              </Text>
            </View>
          </View>
          <Switch
            value={isAvailable}
            onValueChange={setIsAvailable}
            trackColor={{ false: C.border, true: C.mint }}
            thumbColor={C.white}
          />
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Stats row ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.statsRow}>
          {[
            { num: `${CHEF_PROFILE.rating}ÃƒÂ¢Ã‹Å“Ã¢â‚¬Â¦`, label: 'Rating', sub: `${CHEF_PROFILE.ratingCount} reviews` },
            { num: String(CHEF_PROFILE.orders), label: 'Orders', sub: 'Completed' },
            { num: CHEF_PROFILE.responseTime, label: 'Response', sub: 'Avg time' },
            { num: `ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¹${Math.round(CHEF_PROFILE.earnings.total / 1000)}k`, label: 'Earned', sub: 'Total' },
          ].map((s, i, arr) => (
            <View key={s.label} style={[chefSt.statItem, i < arr.length - 1 && chefSt.statDivider]}>
              <Text style={chefSt.statNum}>{s.num}</Text>
              <Text style={chefSt.statLabel}>{s.label}</Text>
              <Text style={chefSt.statSub}>{s.sub}</Text>
            </View>
          ))}
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Culinary Expertise ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.section}>
          <View style={chefSt.secRow}>
            <Text style={chefSt.secTitle}>Culinary Expertise</Text>
            <TouchableOpacity style={chefSt.addBtn} activeOpacity={0.75}>
              <Text style={chefSt.addBtnText}>+ Add Style</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.chipRow}>
            {culinaryStyles.map((style) => (
              <TouchableOpacity
                key={style}
                style={chefSt.expertiseChip}
                activeOpacity={0.75}
                onLongPress={() => removeStyle(style)}
              >
                <Text style={chefSt.expertiseChipText}>{style}</Text>
                <Text style={chefSt.expertiseX}>ÃƒÆ’Ã¢â‚¬â€</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={chefSt.hint}>Long-press a style to remove it</Text>
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Signature Dishes ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.section}>
          <View style={chefSt.secRow}>
            <Text style={chefSt.secTitle}>Signature Dishes</Text>
            <TouchableOpacity style={chefSt.addBtn} activeOpacity={0.75}>
              <Text style={chefSt.addBtnText}>+ Add Dish</Text>
            </TouchableOpacity>
          </View>
          <View style={chefSt.dishGrid}>
            {CHEF_PROFILE.specialities.map((dish) => (
              <View key={dish.name} style={chefSt.dishChip}>
                <Text style={chefSt.dishEmoji}>{dish.emoji}</Text>
                <Text style={chefSt.dishName}>{dish.name}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Bio / About ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.section}>
          <View style={chefSt.secRow}>
            <Text style={chefSt.secTitle}>About Me</Text>
            <TouchableOpacity
              style={chefSt.addBtn}
              activeOpacity={0.75}
              onPress={() => setEditingBio(!editingBio)}
            >
              <Text style={chefSt.addBtnText}>{editingBio ? 'ÃƒÂ¢Ã…â€œÃ¢â‚¬Å“ Done' : 'ÃƒÂ¢Ã…â€œÃ‚ÂÃƒÂ¯Ã‚Â¸Ã‚Â Edit'}</Text>
            </TouchableOpacity>
          </View>
          {editingBio ? (
            <TextInput
              style={chefSt.bioInput}
              value={bio}
              onChangeText={setBio}
              multiline
              textAlignVertical="top"
              placeholderTextColor="#BDB5AB"
              placeholder="Tell buyers about your cooking..."
            />
          ) : (
            <Text style={chefSt.bioText}>{bio}</Text>
          )}
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Kitchen Gallery ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.section}>
          <View style={chefSt.secRow}>
            <Text style={chefSt.secTitle}>Kitchen Gallery</Text>
            <Text style={chefSt.galleryCount}>{kitchenUris.length} / 6 photos</Text>
          </View>
          <View style={chefSt.gallery}>
            {kitchenUris.map((uri, i) => (
              <Image
                key={i}
                source={{ uri }}
                style={[chefSt.galleryImg, { width: IMG_SIZE, height: IMG_SIZE }]}
              />
            ))}
            {kitchenUris.length < 6 ? (
              <TouchableOpacity
                style={[chefSt.galleryAdd, { width: IMG_SIZE, height: IMG_SIZE }]}
                activeOpacity={0.75}
                onPress={() =>
                  pickImage([1, 1], (uri) => setKitchenUris((prev) => [...prev, uri]))
                }
              >
                <Text style={chefSt.galleryAddIcon}>+</Text>
                <Text style={chefSt.galleryAddText}>Add Photo</Text>
              </TouchableOpacity>
            ) : null}
            {kitchenUris.length === 0 ? (
              <View style={chefSt.galleryEmpty}>
                <Text style={chefSt.galleryEmptyText}>
                  ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â¸  Add photos of your kitchen and dishes ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â buyers love to see where their food is cooked!
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Reviews ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.section}>
          <View style={chefSt.secRow}>
            <Text style={chefSt.secTitle}>Reviews</Text>
            <View style={chefSt.ratingPill}>
              <Text style={chefSt.ratingPillText}>* {CHEF_PROFILE.rating} · {CHEF_PROFILE.ratingCount} reviews</Text>
            </View>
          </View>
          {CHEF_PROFILE.reviews.map((review) => (
            <View key={review.id} style={chefSt.reviewCard}>
              <View style={chefSt.reviewTop}>
                <View style={chefSt.reviewAv}>
                  <Text style={chefSt.reviewAvText}>{review.initial}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={chefSt.reviewName}>{review.name}</Text>
                  <Text style={chefSt.reviewDate}>{review.date}</Text>
                </View>
                <View style={chefSt.reviewStars}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Text key={i} style={{ color: i <= review.rating ? C.turmeric : C.border, fontSize: 12 }}>*</Text>
                  ))}
                </View>
              </View>
              <Text style={chefSt.reviewComment}>"{review.comment}"</Text>
            </View>
          ))}
        </View>

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Earnings ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        <View style={chefSt.earningsCard}>
          <Text style={chefSt.earningsTitle}>ÃƒÂ°Ã…Â¸Ã¢â‚¬â„¢Ã‚Â° Earnings Overview</Text>
          <View style={chefSt.earningsRow}>
            <View style={chefSt.earningCol}>
              <Text style={chefSt.earningAmt}>ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¹{CHEF_PROFILE.earnings.month.toLocaleString()}</Text>
              <Text style={chefSt.earningLabel}>This Month</Text>
            </View>
            <View style={chefSt.earningLine} />
            <View style={chefSt.earningCol}>
              <Text style={chefSt.earningAmt}>ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¹{CHEF_PROFILE.earnings.total.toLocaleString()}</Text>
              <Text style={chefSt.earningLabel}>Total Earned</Text>
            </View>
          </View>
          <TouchableOpacity style={chefSt.payoutBtn} activeOpacity={0.85}>
            <Text style={chefSt.payoutBtnText}>Request Payout ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
    </>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Cooking Feed Card helpers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function SteamDot({ delay }: { delay: number }) {
  const y = useRef(new Animated.Value(0)).current;
  const op = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(y, { toValue: -18, duration: 1200, useNativeDriver: true }),
          Animated.sequence([
            Animated.timing(op, { toValue: 0.7, duration: 400, useNativeDriver: true }),
            Animated.timing(op, { toValue: 0, duration: 800, useNativeDriver: true }),
          ]),
        ]),
        Animated.parallel([
          Animated.timing(y, { toValue: 0, duration: 0, useNativeDriver: true }),
          Animated.timing(op, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={[feedSt.steamDot, { opacity: op, transform: [{ translateY: y }] }]} />;
}

function CookingDishCard({
  item, timeLeft, bargainSent, onChefPress, onOrderPress,
}: {
  item: CookingFeedCard;
  timeLeft: string | null;
  bargainSent: boolean;
  onChefPress: () => void;
  onOrderPress: () => void;
}) {
  const cardScale = useRef(new Animated.Value(0.97)).current;

  useEffect(() => {
    Animated.spring(cardScale, { toValue: 1, tension: 70, friction: 7, useNativeDriver: true }).start();
  }, []);

  const isReady = item.status === 'ready';

  return (
    <Animated.View style={[feedSt.cookCard, { transform: [{ scale: cardScale }] }]}>
      {/* Top row: image/emoji + info */}
      <View style={feedSt.cookRow}>
        {/* Left: food image or emoji */}
        <View style={feedSt.cookImgBox}>
          {item.imageUri ? (
            <Image source={{ uri: item.imageUri }} style={feedSt.cookImgFull} />
          ) : (
            <Text style={feedSt.cookImgEmoji}>{item.emoji}</Text>
          )}
          <View style={[feedSt.cookEtaBadge, isReady && feedSt.cookEtaBadgeReady]}>
            <Text style={feedSt.cookEtaText}>{isReady ? 'Ready' : (timeLeft ?? 'Soon')}</Text>
          </View>
        </View>

        {/* Right: dish info */}
        <View style={feedSt.cookInfo}>
          <Text style={feedSt.cookDish} numberOfLines={2}>{item.dish}</Text>
          <TouchableOpacity style={feedSt.cookChefRow} activeOpacity={0.7} onPress={onChefPress}>
            <View style={feedSt.cookAvatar}>
              <Text style={feedSt.cookAvatarText}>{item.chefInitial}</Text>
            </View>
            <Text style={feedSt.cookChefName}>{item.chefName}</Text>
            <Text style={feedSt.cookDot}> · </Text>
            <Text style={feedSt.cookDist}>{item.distance}</Text>
          </TouchableOpacity>
          <Text style={feedSt.cookTagsLine} numberOfLines={1}>{item.tags.join('  ·  ')}</Text>
        </View>
      </View>

      {/* Divider */}
      <View style={feedSt.cookDivider} />

      {/* Footer: rating + price + CTA */}
      <View style={feedSt.cookFooter}>
        <View style={feedSt.cookFooterLeft}>
          <View style={feedSt.cookRatingBadge}>
            <Text style={feedSt.cookRatingBadgeText}>★ {item.rating}</Text>
          </View>
          <Text style={feedSt.cookMetaItem}>· Serves {item.serves}</Text>
        </View>
        <View style={feedSt.cookFooterRight}>
          <Text style={feedSt.cookPrice}>Rs {item.price}</Text>
          {bargainSent ? (
            <View style={feedSt.cookCtaSent}>
              <Text style={feedSt.cookCtaSentText}>Sent ✓</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[feedSt.cookCta, !isReady && feedSt.cookCtaPreOrder]}
              activeOpacity={0.85}
              onPress={onOrderPress}
            >
              <Text style={feedSt.cookCtaText}>{isReady ? 'Order Now' : 'Pre-Order'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

function StepDots({ current = 1, total = 3 }: { current?: number; total?: number }) {
  return (
    <View style={styles.stepDots}>
      {Array.from({ length: total }).map((_, index) => (
        <View key={index} style={[styles.dot, index + 1 === current ? styles.dotActive : null]} />
      ))}
    </View>
  );
}

function FieldLabel({ text }: { text: string }) {
  return <Text style={styles.fieldLabel}>{text}</Text>;
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, selected ? styles.chipSelected : null]} onPress={onPress} activeOpacity={0.75}>
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Stepper({ value, unit, onMinus, onPlus }: { value: number; unit: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <View style={styles.stepperRow}>
      <TouchableOpacity style={styles.stepBtn} onPress={onMinus} activeOpacity={0.75}>
        <Text style={styles.stepBtnText}>ÃƒÂ¢Ã‹â€ Ã¢â‚¬â„¢</Text>
      </TouchableOpacity>
      <Text style={styles.stepValue}>{value}</Text>
      <Text style={styles.stepUnit}>{unit}</Text>
      <TouchableOpacity style={styles.stepBtn} onPress={onPlus} activeOpacity={0.75}>
        <Text style={styles.stepBtnText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

function StatBox({ num, label }: { num: string; label: string }) {
  return (
    <View style={profileSt.statBox}>
      <Text style={profileSt.statNum}>{num}</Text>
      <Text style={profileSt.statLabel}>{label}</Text>
    </View>
  );
}

function MenuItem({ item }: { item: { icon: string; iconBg: string; label: string; sub: string; badge: string | null } }) {
  return (
    <TouchableOpacity style={styles.menuItem} activeOpacity={0.75}>
      <View style={styles.menuLeft}>
        <View style={[styles.menuIcon, { backgroundColor: item.iconBg }]}>
          <Text style={styles.menuIconText}>{item.icon}</Text>
        </View>
        <View>
          <Text style={styles.menuLabel}>{item.label}</Text>
          <Text style={styles.menuSub}>{item.sub}</Text>
        </View>
      </View>
      <View style={styles.menuRight}>
        {item.badge ? <View style={styles.menuBadge}><Text style={styles.menuBadgeText}>{item.badge}</Text></View> : null}
        <Text style={styles.menuArrow}>›</Text>
      </View>
    </TouchableOpacity>
  );
}

function StarRating({ count }: { count: number }) {
  return <View style={styles.starRow}>{[1, 2, 3, 4, 5].map((i) => <Text key={i} style={[styles.star, { color: i <= count ? C.turmeric : C.border }]}>★</Text>)}</View>;
}

function HoldOrderCard({
  offer,
  timeLeft,
  onPay,
}: {
  offer: DishOfferItem;
  timeLeft: string | null;
  onPay: () => void;
}) {
  return (
    <View style={orderTabSt.holdCard}>
      <View style={orderTabSt.cardTop}>
        <View style={orderTabSt.emojiWrap}>
          <Text style={orderTabSt.emojiText}>{offer.dishEmoji}</Text>
        </View>
        <View style={orderTabSt.cardInfo}>
          <Text style={orderTabSt.cardName}>{offer.dishName}</Text>
          <Text style={orderTabSt.cardMeta}>{offer.plates} plate{offer.plates > 1 ? 's' : ''} · ₹{offer.agreedPrice ?? offer.offerPrice}/plate</Text>
          <Text style={orderTabSt.holdTime}>⏱ Expires in {timeLeft ?? '0:00'}</Text>
        </View>
        <View style={orderTabSt.holdBadge}>
          <Text style={orderTabSt.holdBadgeText}>{timeLeft ?? '0:00'}</Text>
        </View>
      </View>
      <TouchableOpacity style={orderTabSt.payBtn} activeOpacity={0.85} onPress={onPay}>
        <Text style={orderTabSt.payBtnText}>Pay Now  ₹{(offer.agreedPrice ?? offer.offerPrice) * offer.plates}</Text>
      </TouchableOpacity>
    </View>
  );
}

function RequestHoldOrderCard({
  order,
  timeLeft,
  onPay,
}: {
  order: BuyerRequestOrderItem;
  timeLeft: string | null;
  onPay: () => void;
}) {
  return (
    <View style={orderTabSt.holdCard}>
      <View style={orderTabSt.cardTop}>
        <View style={orderTabSt.emojiWrap}>
          <Text style={orderTabSt.emojiText}>{FOOD_CATEGORIES.find((item) => item.label.toLowerCase() === order.request.category.toLowerCase())?.emoji ?? '🍲'}</Text>
        </View>
        <View style={orderTabSt.cardInfo}>
          <Text style={orderTabSt.cardName}>{order.request.dishName}</Text>
          <Text style={orderTabSt.cardMeta}>Request order · ₹{order.finalPrice}</Text>
          <Text style={orderTabSt.holdTime}>⏱ Expires in {timeLeft ?? '0:00'}</Text>
        </View>
        <View style={orderTabSt.holdBadge}>
          <Text style={orderTabSt.holdBadgeText}>{timeLeft ?? '0:00'}</Text>
        </View>
      </View>
      <TouchableOpacity style={orderTabSt.payBtn} activeOpacity={0.85} onPress={onPay}>
        <Text style={orderTabSt.payBtnText}>Pay Now  ₹{order.finalPrice}</Text>
      </TouchableOpacity>
    </View>
  );
}

function PendingApprovalCard({ offer }: { offer: DishOfferItem }) {
  return (
    <View style={orderTabSt.pendingCard}>
      <View style={orderTabSt.cardTop}>
        <View style={orderTabSt.emojiWrap}>
          <Text style={orderTabSt.emojiText}>{offer.dishEmoji}</Text>
        </View>
        <View style={orderTabSt.cardInfo}>
          <Text style={orderTabSt.cardName}>{offer.dishName}</Text>
          <Text style={orderTabSt.cardMeta}>{offer.plates} plate{offer.plates > 1 ? 's' : ''} · ₹{offer.offerPrice}/plate</Text>
          <Text style={orderTabSt.pendingTime}>Waiting for chef to approve</Text>
        </View>
        <View style={orderTabSt.pendingBadge}>
          <Text style={orderTabSt.pendingBadgeText}>Pending</Text>
        </View>
      </View>
    </View>
  );
}

function PlacedOrderCard({ offer, onPayBalance }: { offer: DishOfferItem; onPayBalance?: () => void }) {
  const orderStatusLabel = getOfferOrderStatusLabel(offer);
  const totalPrice = (offer.agreedPrice ?? offer.offerPrice) * offer.plates;
  const balanceDue = offer.status === 'ADVANCE_PAID' && offer.advancePaid != null ? totalPrice - offer.advancePaid : null;
  return (
    <View style={orderTabSt.placedCard}>
      <View style={orderTabSt.cardTop}>
        <View style={orderTabSt.emojiWrap}>
          <Text style={orderTabSt.emojiText}>{offer.dishEmoji}</Text>
        </View>
        <View style={orderTabSt.cardInfo}>
          <Text style={orderTabSt.cardName}>{offer.dishName}</Text>
          <Text style={orderTabSt.cardMeta}>{offer.plates} plate{offer.plates > 1 ? 's' : ''} · ₹{offer.agreedPrice ?? offer.offerPrice}/plate</Text>
          <Text style={orderTabSt.placedTime}>Paid {timeAgo(offer.paidAt ?? offer.updatedAt)} · {offer.deliveryMode === 'delivery' ? 'Delivery' : 'Pickup'}</Text>
          {offer.status === 'ADVANCE_PAID' ? (
            <Text style={orderTabSt.advanceBadge}>20% advance paid · Balance: ₹{balanceDue}</Text>
          ) : null}
        </View>
        <View style={orderTabSt.placedBadge}>
          <Text style={orderTabSt.placedBadgeText}>{orderStatusLabel}</Text>
        </View>
      </View>
      <View style={orderTabSt.placedFooter}>
        <Text style={orderTabSt.placedFooterLabel}>Ref: {offer.paymentRef ?? 'DEMO'}</Text>
        <Text style={orderTabSt.placedFooterValue}>₹{totalPrice}</Text>
      </View>
      {offer.status === 'ADVANCE_PAID' && onPayBalance ? (
        <TouchableOpacity style={orderTabSt.payBalanceBtn} activeOpacity={0.85} onPress={onPayBalance}>
          <Text style={orderTabSt.payBalanceBtnText}>Pay Balance  ₹{balanceDue}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function RequestPlacedOrderCard({ order, onPayBalance }: { order: BuyerRequestOrderItem; onPayBalance?: () => void }) {
  const orderStatusLabel =
    order.status === 'OUT_FOR_DELIVERY' ? 'Dispatched'
      : order.status === 'DELIVERED' ? 'Delivered'
        : order.status === 'READY' ? 'Ready'
          : order.status === 'COOKING' ? 'Cooking'
            : 'Confirmed';
  const balanceDue = order.paymentStatus === 'ADVANCE_PAID' && order.advancePaid != null ? order.finalPrice - order.advancePaid : null;

  return (
    <View style={orderTabSt.placedCard}>
      <View style={orderTabSt.placedTop}>
        <View style={orderTabSt.placedEmojiWrap}>
          <Text style={orderTabSt.placedEmoji}>{FOOD_CATEGORIES.find((item) => item.label.toLowerCase() === order.request.category.toLowerCase())?.emoji ?? 'Custom'}</Text>
        </View>
        <View style={orderTabSt.placedInfo}>
          <Text style={orderTabSt.placedName}>{order.request.dishName}</Text>
          <Text style={orderTabSt.placedMeta}>Request order · ₹{order.finalPrice}</Text>
          <Text style={orderTabSt.placedTime}>Paid {timeAgo(order.paidAt ?? order.updatedAt)} · {order.request.delivery === 'delivery' ? 'Home delivery' : 'Self pickup'}</Text>
          {order.paymentStatus === 'ADVANCE_PAID' ? (
            <Text style={orderTabSt.advanceBadge}>20% advance paid · Balance: ₹{balanceDue}</Text>
          ) : null}
          {order.status === 'COOKING' && order.readyAt ? (
            <Text style={orderTabSt.cookingTimer}>🍳 Ready in {countdownTo(order.readyAt) ?? '0m 00s'}</Text>
          ) : null}
        </View>
        <View style={orderTabSt.placedBadge}>
          <Text style={orderTabSt.placedBadgeText}>{orderStatusLabel}</Text>
        </View>
      </View>
      <View style={orderTabSt.placedFooter}>
        <Text style={orderTabSt.placedFooterLabel}>{orderStatusLabel} · Payment ref {order.paymentRef ?? "DEMO"}</Text>
        <Text style={orderTabSt.placedFooterValue}>₹{order.finalPrice}</Text>
      </View>
      {order.paymentStatus === 'ADVANCE_PAID' && onPayBalance ? (
        <TouchableOpacity style={orderTabSt.payBalanceBtn} activeOpacity={0.85} onPress={onPayBalance}>
          <Text style={orderTabSt.payBalanceBtnText}>Pay Balance  ₹{balanceDue}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function RecentOrderCard({
  item,
  onReorder,
}: {
  item: { emoji: string; emojiBg: string; name: string; chef: string; date: string; price: string; status: string; statusColor: string; rated: boolean; rating: number };
  onReorder: () => void;
}) {
  return (
    <View style={styles.orderCard}>
      <View style={styles.orderTop}>
        <View style={[styles.orderEmoji, { backgroundColor: item.emojiBg }]}>
          <Text style={styles.orderEmojiText}>{item.emoji}</Text>
        </View>
        <View style={styles.orderInfo}>
          <Text style={styles.orderName}>{item.name}</Text>
          <Text style={styles.orderMeta}>by {item.chef} | {item.date}</Text>
          {item.rated ? <StarRating count={item.rating} /> : <TouchableOpacity activeOpacity={0.75}><Text style={styles.rateNow}>{'Rate this order >'}</Text></TouchableOpacity>}
        </View>
        <View style={styles.orderRight}>
          <Text style={styles.orderPrice}>{item.price}</Text>
          <Text style={[styles.orderStatus, { color: item.statusColor }]}>{item.status}</Text>
        </View>
      </View>
      <TouchableOpacity style={styles.reorderBtn} onPress={onReorder} activeOpacity={0.8}>
        <Text style={styles.reorderBtnText}>Reorder</Text>
      </TouchableOpacity>
    </View>
  );
}

function OrderSummaryCard({ budget, title = 'Chicken Curry', subtitle = '1 kg | Extra Spicy | Bone-in | 2 people', emoji }: { budget: number; title?: string; subtitle?: string; emoji?: string }) {
  return (
    <View style={styles.orderSummary}>
      <View style={styles.orderSummaryEmoji}>
        <Text style={styles.orderSummaryEmojiText}>{emoji ?? "🍲"}</Text>
      </View>
      <View style={styles.orderSummaryInfo}>
        <Text style={styles.orderSummaryName}>{title}</Text>
        <Text style={styles.orderSummarySub}>{subtitle}</Text>
      </View>
      <View style={styles.orderSummaryBudget}>
        <Text style={styles.orderSummaryBudgetNum}>₹{budget}</Text>
        <Text style={styles.orderSummaryBudgetLabel}>BUDGET</Text>
      </View>
    </View>
  );
}

function QuoteCard({
  item,
  onAccept,
  onReject,
  onCounter,
}: {
  item: BuyerQuoteCardItem;
  onAccept: () => void;
  onReject: () => void;
  onCounter: () => void;
}) {
  return (
    <View style={[styles.quoteCard, item.isBest ? styles.quoteCardBest : null]}>
      {/* Chef info + price */}
      <View style={styles.qcTop}>
        <View style={[styles.chefAv, { backgroundColor: item.avatarColor }]}>
          <Text style={styles.chefAvText}>{item.initial}</Text>
        </View>
        <View style={styles.qcChefInfo}>
          <View style={styles.nameRow}>
            <Text style={styles.chefName}>{item.name}</Text>
            {item.isBest ? (
              <View style={styles.bestBadge}>
                <Text style={styles.bestBadgeText}>Best Match</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.chefMeta}>★ {item.rating} · {item.orders} orders · {item.distance}</Text>
        </View>
        <Text style={styles.qcPrice}>₹{item.price}</Text>
      </View>

      {/* Details row */}
      <View style={styles.qcMid}>
        {[
          { label: item.cookTime, sub: 'Cook Time' },
          { label: item.delivery, sub: 'Delivery' },
          { label: item.style, sub: 'Style' },
        ].map((detail) => (
          <View key={`${item.id}-${detail.sub}`} style={styles.detailPill}>
            <Text style={styles.detailVal}>{detail.label}</Text>
            <Text style={styles.detailSub}>{detail.sub}</Text>
          </View>
        ))}
      </View>

      {/* Counters left */}
      <View style={styles.qcCounterRow}>
        <Text style={styles.qcCounterMeta}>Your counters left: {item.buyerCountersLeft}</Text>
        <Text style={styles.qcCounterMeta}>Chef counters left: {item.chefCountersLeft}</Text>
      </View>

      {/* Actions */}
      <View style={styles.qcActions}>
        <TouchableOpacity style={styles.btnAccept} onPress={onAccept} activeOpacity={0.85}>
          <Text style={styles.btnAcceptText}>✓ Accept ₹{item.price}</Text>
        </TouchableOpacity>
        <View style={styles.qcSecondaryActions}>
          {item.buyerCountersLeft > 0 ? (
            <TouchableOpacity style={styles.btnCounter} onPress={onCounter} activeOpacity={0.85}>
              <Text style={styles.btnCounterText}>Counter</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.btnReject} onPress={onReject} activeOpacity={0.85}>
            <Text style={styles.btnRejectText}>Reject</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function CounterModal({
  visible,
  chef,
  currentBudget,
  onClose,
  onSend,
}: {
  visible: boolean;
  chef: BuyerQuoteCardItem | null;
  currentBudget: number;
  onClose: () => void;
  onSend: (offer: number) => void;
}) {
  const [offer, setOffer] = useState(String(currentBudget));

  useEffect(() => {
    setOffer(String(currentBudget));
  }, [currentBudget, chef?.rawQuote.id, visible]);

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={modalStyles.overlay}>
        <View style={modalStyles.sheet}>
          <View style={modalStyles.handle} />
          <Text style={modalStyles.title}>Counter Offer to {chef?.name}</Text>
          <Text style={modalStyles.sub}>Their quote: ₹{chef?.price}. Enter your offer below.</Text>
          <Text style={modalStyles.limitNote}>You have {chef?.buyerCountersLeft ?? 0} quote{(chef?.buyerCountersLeft ?? 0) === 1 ? '' : 's'} left in this negotiation.</Text>

          <View style={modalStyles.inputWrap}>
            <Text style={modalStyles.rupee}>₹</Text>
            <TextInput
              style={modalStyles.input}
              value={offer}
              onChangeText={setOffer}
              keyboardType="numeric"
              placeholder="Enter amount"
              placeholderTextColor="#BDB5AB"
            />
          </View>

          <View style={modalStyles.actions}>
            <TouchableOpacity style={modalStyles.cancelBtn} onPress={onClose} activeOpacity={0.75}>
              <Text style={modalStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={modalStyles.sendBtn}
              onPress={() => {
                onSend(Number(offer));
              }}
              activeOpacity={0.85}
            >
              <Text style={modalStyles.sendText}>Send Counter Rs {offer}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function HomeParticle({ x, delay, emoji }: { x: number; delay: number; emoji: string }) {
  const y = useRef(new Animated.Value(0)).current;
  const op = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(y, { toValue: -18, duration: 1800, useNativeDriver: true }),
          Animated.sequence([
            Animated.timing(op, { toValue: 1, duration: 500, useNativeDriver: true }),
            Animated.timing(op, { toValue: 0, duration: 1300, useNativeDriver: true }),
          ]),
        ]),
        Animated.timing(y, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [delay, op, y]);

  return (
    <Animated.Text style={[homeFx.particle, { left: x, opacity: op, transform: [{ translateY: y }] }]}>
      {emoji}
    </Animated.Text>
  );
}

function HomePulseRing() {
  const scale = useRef(new Animated.Value(1)).current;
  const op = useRef(new Animated.Value(0.55)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.timing(scale, { toValue: 1.35, duration: 1200, useNativeDriver: true }),
        Animated.timing(op, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [op, scale]);

  return <Animated.View style={[homeFx.pulseRing, { transform: [{ scale }], opacity: op }]} />;
}

function BuyerHomeBanner({ onPress }: { onPress: () => void }) {
  const slide = useRef(new Animated.Value(18)).current;
  const op = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slide, { toValue: 0, duration: 550, useNativeDriver: true }),
      Animated.timing(op, { toValue: 1, duration: 550, useNativeDriver: true }),
    ]).start();
  }, [op, slide]);

  return (
    <Animated.View style={[homeFx.banner, { opacity: op, transform: [{ translateY: slide }] }]}>
      <View style={homeFx.bannerBg} />
      <View style={homeFx.bannerBlob1} />
      <View style={homeFx.bannerBlob2} />
      <HomeParticle x={18} delay={0} emoji={'\uD83C\uDF5B'} />
      <HomeParticle x={62} delay={500} emoji={'\uD83C\uDF57'} />
      <HomeParticle x={108} delay={250} emoji={'\uD83E\uDD58'} />
      <View style={homeFx.bannerContent}>
        <View style={homeFx.bannerCopy}>
          <View style={homeFx.bannerPill}>
            <View style={homeFx.bannerPillDot} />
            <Text style={homeFx.bannerPillText}>NEW REQUEST</Text>
          </View>
          <Text style={homeFx.bannerTitle}>Hungry? Post a{'\n'}craving in 30 sec</Text>
          <Text style={homeFx.bannerSub}>Local home chefs will respond</Text>
        </View>
        <View style={homeFx.bannerAction}>
          <View style={homeFx.ctaWrap}>
            <HomePulseRing />
            <TouchableOpacity style={homeFx.ctaBtn} activeOpacity={0.85} onPress={onPress}>
              <Text style={homeFx.ctaBtnText}>Post Now</Text>
              <Text style={homeFx.ctaBtnArrow}>{'\u2192'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

function BuyerHomeTabs({
  active,
  onSwitch,
  notificationCount,
}: {
  active: 'requests' | 'cooking';
  onSwitch: (tab: 'requests' | 'cooking') => void;
  notificationCount: number;
}) {
  const slideAnim = useRef(new Animated.Value(active === 'requests' ? 0 : 1)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: active === 'requests' ? 0 : 1,
      useNativeDriver: false,
      tension: 110,
      friction: 11,
    }).start();
  }, [active, slideAnim]);

  const translateX = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [2, (SCREEN_W - 44) / 2 - 2],
  });

  return (
    <View style={homeFx.tabBar}>
      <Animated.View style={[homeFx.tabSlider, { width: (SCREEN_W - 44) / 2 - 4, transform: [{ translateX }] }]} />
      {[
        { key: 'requests', label: 'Notification Board' },
        { key: 'cooking', label: "What's Cooking" },
      ].map((tab) => (
        <TouchableOpacity
          key={tab.key}
          style={homeFx.tabBtn}
          activeOpacity={0.82}
          onPress={() => onSwitch(tab.key as 'requests' | 'cooking')}
        >
          {tab.key === 'requests' && notificationCount > 0 ? (
            <View style={homeFx.tabBadge}>
              <Text style={homeFx.tabBadgeText}>{notificationCount > 99 ? '99+' : notificationCount}</Text>
            </View>
          ) : null}
          <Text style={[homeFx.tabText, active === tab.key && homeFx.tabTextActive]}>{tab.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function BuyerHomeEmptyState({
  emoji,
  title,
  subtitle,
  hints,
}: {
  emoji: string;
  title: string;
  subtitle: string;
  hints?: Array<{ icon: string; text: string }>;
}) {
  const float = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(1)).current;
  const ring1Op = useRef(new Animated.Value(0.45)).current;
  const ring2 = useRef(new Animated.Value(1)).current;
  const ring2Op = useRef(new Animated.Value(0.26)).current;

  useEffect(() => {
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: -8, duration: 1600, useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 1600, useNativeDriver: true }),
      ]),
    );
    const ringLoop1 = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(ring1, { toValue: 1.45, duration: 1800, useNativeDriver: true }),
          Animated.timing(ring1Op, { toValue: 0, duration: 1800, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(ring1, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(ring1Op, { toValue: 0.45, duration: 0, useNativeDriver: true }),
        ]),
      ]),
    );
    const ringLoop2 = Animated.loop(
      Animated.sequence([
        Animated.delay(600),
        Animated.parallel([
          Animated.timing(ring2, { toValue: 1.52, duration: 1800, useNativeDriver: true }),
          Animated.timing(ring2Op, { toValue: 0, duration: 1800, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(ring2, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(ring2Op, { toValue: 0.26, duration: 0, useNativeDriver: true }),
        ]),
      ]),
    );
    floatLoop.start();
    ringLoop1.start();
    ringLoop2.start();
    return () => {
      floatLoop.stop();
      ringLoop1.stop();
      ringLoop2.stop();
    };
  }, [float, ring1, ring1Op, ring2, ring2Op]);

  return (
    <View style={homeFx.emptyWrap}>
      <View style={homeFx.rippleWrap}>
        <Animated.View style={[homeFx.rippleRing, homeFx.rippleOuter, { transform: [{ scale: ring2 }], opacity: ring2Op }]} />
        <Animated.View style={[homeFx.rippleRing, homeFx.rippleInner, { transform: [{ scale: ring1 }], opacity: ring1Op }]} />
        <Animated.View style={[homeFx.bellCircle, { transform: [{ translateY: float }] }]}>
          <Text style={homeFx.bellEmoji}>{emoji}</Text>
        </Animated.View>
      </View>
      <Text style={homeFx.emptyTitle}>{title}</Text>
      <Text style={homeFx.emptySub}>{subtitle}</Text>
      {hints?.length ? (
        <View style={homeFx.hintRow}>
          {hints.map((hint) => (
            <View key={hint.text} style={homeFx.hintCard}>
              <Text style={homeFx.hintIcon}>{hint.icon}</Text>
              <Text style={homeFx.hintText}>{hint.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function BottomNav({ active, onHomePress, onExplorePress, onRequestPress, onOrdersPress, onProfilePress }: { active: string; onHomePress?: () => void; onExplorePress?: () => void; onRequestPress?: () => void; onOrdersPress?: () => void; onProfilePress?: () => void }) {
  const requestAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(requestAnim, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(requestAnim, { toValue: 0, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [requestAnim]);

  const tabs = [
    { key: 'home', icon: '\uD83C\uDFE0', label: 'Home', onPress: onHomePress },
    { key: 'explore', icon: '\uD83D\uDD0D', label: 'Explore', onPress: onExplorePress },
    { key: 'request', icon: '🍽️', label: 'Request', onPress: onRequestPress },
    { key: 'orders', icon: '\uD83D\uDCE6', label: 'Orders', onPress: onOrdersPress },
    { key: 'profile', icon: '\uD83D\uDC64', label: 'Profile', onPress: onProfilePress },
  ];
  tabs[3].onPress = onOrdersPress;
  return (
    <View style={navStyles.nav}>
      {tabs.map((tab) => (
        <TouchableOpacity key={tab.key} style={navStyles.tab} activeOpacity={0.7} onPress={tab.onPress}>
          {tab.key === 'request' ? (
            <Animated.Text
              style={[
                navStyles.icon,
                active === tab.key ? navStyles.iconActive : null,
                {
                  transform: [
                    { translateY: requestAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) },
                    { scale: requestAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
                  ],
                },
              ]}
            >
              {tab.icon}
            </Animated.Text>
          ) : (
            <Text style={[navStyles.icon, active === tab.key ? navStyles.iconActive : null]}>{tab.icon}</Text>
          )}
          <Text style={[navStyles.label, active === tab.key ? navStyles.labelActive : null]}>{tab.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F2F5F0' },
  keyboardAvoid: { flex: 1 },
  header: { backgroundColor: '#F2F5F0', paddingHorizontal: 22, paddingTop: 10, paddingBottom: 16, borderBottomWidth: 0 },
  headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  brandWrap: { flex: 1, paddingRight: 16, justifyContent: 'center', minHeight: 40 },
  brandRow: { flexDirection: 'row', alignItems: 'baseline' },
  brandFood: { fontSize: 31, fontWeight: '800', color: '#1A1A18', letterSpacing: -1.1 },
  brandSood: { fontSize: 31, fontWeight: '800', color: C.spice, letterSpacing: -1.1 },
  avatarBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.spice, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: C.white, fontWeight: '800', fontSize: 16 },
  avatarBadge: { position: 'absolute', top: 0, right: 0, width: 11, height: 11, borderRadius: 6, backgroundColor: C.turmeric, borderWidth: 2, borderColor: C.white },
  locationPill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', backgroundColor: '#F7F4EE', borderWidth: 1, borderColor: '#E4DED2', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 8, marginBottom: 14, shadowColor: 'rgba(26,38,32,0.08)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 2 },
  locationText: { fontSize: 12, color: '#1A2620', fontWeight: '700' },
  locationGpsBadge: { fontSize: 10, color: C.mint, fontWeight: '700', backgroundColor: C.paleGreen, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, marginLeft: 4, overflow: 'hidden' },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F7F4EE', borderWidth: 1.5, borderColor: '#E4DED2', borderRadius: 22, paddingHorizontal: 18, paddingVertical: 18, gap: 10, shadowColor: 'rgba(26,38,32,0.08)', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.1, shadowRadius: 16, elevation: 2 },
  searchIcon: { fontSize: 18 },
  searchPlaceholder: { fontSize: 13, color: '#A5A49D', fontWeight: '500' },
  scroll: { flex: 1 },
  homeScrollContent: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 100 },
  postScrollContent: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 120 },
  profileScrollContent: { paddingBottom: 100 },
  postCta: { marginHorizontal: 18, marginTop: 16, marginBottom: 4, backgroundColor: C.ink, borderRadius: 20, padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  postCtaText: { flex: 1 },
  postCtaEyebrow: { fontSize: 9, fontWeight: '700', color: C.turmeric, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 },
  postCtaTitle: { fontSize: 17, fontWeight: '700', color: C.white, lineHeight: 22 },
  postCtaBtn: { backgroundColor: C.spice, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginLeft: 12 },
  postCtaBtnText: { color: C.white, fontSize: 12, fontWeight: '700' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, marginTop: 20, marginBottom: 10 },
  sectionHeading: { fontSize: 14, fontWeight: '700', color: C.ink },
  seeAll: { fontSize: 12, color: C.spice, fontWeight: '600' },
  catScroll: { paddingHorizontal: 18, paddingBottom: 6, gap: 12 },
  catChip: { width: 88, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', gap: 7, backgroundColor: C.white, borderWidth: 1, borderColor: C.border },
  catIcon: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  catIconSelected: { borderColor: C.spice },
  catEmoji: { fontSize: 26 },
  catLabel: { fontSize: 10, fontWeight: '600', color: C.warmGray },
  catLabelSelected: { color: C.spice },
  reqCard: { marginHorizontal: 18, marginBottom: 12, backgroundColor: C.white, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, shadowColor: C.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  reqTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  reqFoodRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reqEmoji: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  reqEmojiText: { fontSize: 22 },
  reqName: { fontSize: 14, fontWeight: '700', color: C.ink },
  reqBy: { fontSize: 11, color: C.warmGray, marginTop: 1 },
  statusBadge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6 },
  statusText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  tinyTag: { backgroundColor: C.cream, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  tinyTagText: { fontSize: 10, fontWeight: '500', color: C.warmGray },
  reqBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  reqPriceStack: { flexShrink: 1, minWidth: 0 },
  reqPrice: { fontSize: 19, fontWeight: '800', color: C.ink },
  reqPriceLabel: { fontSize: 10, color: C.warmGray },
  reqPriceSecondary: { fontSize: 15, fontWeight: '800', color: C.spice, marginTop: 6 },
  reqPriceSecondaryLabel: { fontSize: 10, color: C.warmGray },
  quotesRow: { flexDirection: 'row', alignItems: 'center' },
  quotesBadge: { borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  quotesBadgeText: { color: C.white, fontSize: 10, fontWeight: '700' },
  quotesLabel: { fontSize: 11, color: C.warmGray },
  postHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.white, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 14 },
  postHeaderCenter: { flex: 1, alignItems: 'center' },
  postStepLabel: { fontSize: 10, fontWeight: '600', color: C.warmGray, marginTop: 2 },
  postProgressTrack: { height: 3, backgroundColor: C.border },
  postProgressFill: { height: 3, width: '33%', backgroundColor: C.spice },
  backBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: C.cream, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  backIcon: { fontSize: 20, color: C.ink, fontWeight: '700' },
  headerTitle: { fontSize: 16, fontWeight: '800', color: C.ink, letterSpacing: -0.3 },
  stepDots: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.border },
  dotActive: { width: 20, height: 6, borderRadius: 3, backgroundColor: C.spice },
  fieldGroup: { marginBottom: 14, backgroundColor: C.white, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 16, shadowColor: C.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  fieldLabel: { fontSize: 13, fontWeight: '800', color: C.ink, marginBottom: 12, letterSpacing: -0.2 },
  dishSuggestWrap: { position: 'relative', zIndex: 20 },
  dishSuggestMenu: { marginTop: 8, backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.border, overflow: 'hidden', shadowColor: C.ink, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 4 },
  dishSuggestItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  dishSuggestIcon: { fontSize: 18 },
  dishSuggestCopy: { flex: 1 },
  dishSuggestName: { fontSize: 13, fontWeight: '700', color: C.ink },
  dishSuggestSub: { fontSize: 10, color: C.warmGray, marginTop: 2 },
  foodScroll: { paddingRight: 18, gap: 10 },
  foodPickItem: { width: 92, minHeight: 108, borderRadius: 18, borderWidth: 1.5, borderColor: C.border, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', gap: 6, backgroundColor: C.cream },
  foodPickItemSelected: { borderColor: C.spice, backgroundColor: '#FFF6F1' },
  fpEmojiWrap: { width: 48, height: 48, borderRadius: 15, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' },
  fpEmojiWrapSelected: { backgroundColor: C.blush },
  fpEmoji: { fontSize: 26 },
  fpName: { fontSize: 11, fontWeight: '700', color: C.ink, textAlign: 'center' },
  fpNameSelected: { color: C.spice },
  fpHint: { fontSize: 9, lineHeight: 12, color: C.warmGray, textAlign: 'center' },
  fpHintSelected: { color: '#D97757' },
  input: { backgroundColor: C.cream, borderRadius: 12, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 12, fontSize: 14, color: C.ink },
  qtyBox: { backgroundColor: C.cream, borderRadius: 14, padding: 16 },
  qtyTopRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 },
  qtyValue: { fontSize: 30, fontWeight: '800', color: C.ink },
  qtySubValue: { fontSize: 12, color: C.warmGray, fontWeight: '600' },
  qtySlider: { width: '100%', height: 38 },
  qtyRangeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
  qtyRangeText: { fontSize: 10, color: C.warmGray },
  servingHintCard: { marginTop: 14, backgroundColor: C.white, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border },
  servingHintLabel: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, color: C.warmGray },
  servingHintValue: { fontSize: 15, fontWeight: '800', color: C.ink, marginTop: 4 },
  servingHintSub: { fontSize: 11, color: C.warmGray, lineHeight: 16, marginTop: 4 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 36, height: 36, borderRadius: 10, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.cream, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: 20, fontWeight: '700', color: C.ink, lineHeight: 24 },
  stepValue: { fontSize: 22, fontWeight: '800', color: C.ink, minWidth: 34, textAlign: 'center' },
  stepUnit: { fontSize: 12, color: C.warmGray },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 24, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.cream },
  chipSelected: { borderColor: C.spice, backgroundColor: C.blush },
  chipText: { fontSize: 13, fontWeight: '600', color: C.warmGray },
  chipTextSelected: { color: C.spice, fontWeight: '700' },
  prefInlineMoreBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: C.spice, backgroundColor: '#FFF6F1' },
  prefInlineMoreText: { fontSize: 12, fontWeight: '700', color: C.spice },
  prefMoreBtn: { alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: C.cream, borderWidth: 1, borderColor: C.border },
  prefMoreText: { fontSize: 12, fontWeight: '700', color: C.spice },
  sectionToggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionToggleText: { fontSize: 12, fontWeight: '700', color: C.spice },
  sectionToggleHint: { fontSize: 12, color: C.warmGray, lineHeight: 18, backgroundColor: C.cream, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  sideList: { gap: 10 },
  sideCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  sideCardActive: { borderColor: C.spice, backgroundColor: '#FFF6F1' },
  sideCopy: { flex: 1, paddingRight: 12 },
  sideName: { fontSize: 13, fontWeight: '700', color: C.ink },
  sideMeta: { fontSize: 11, color: C.warmGray, marginTop: 2 },
  sideStepper: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sideStepBtn: { width: 30, height: 30, borderRadius: 9, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' },
  sideStepText: { fontSize: 18, fontWeight: '700', color: C.ink, lineHeight: 20 },
  sideQty: { minWidth: 18, textAlign: 'center', fontSize: 15, fontWeight: '800', color: C.ink },
  remarksInput: { minHeight: 96, backgroundColor: C.cream, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: C.ink, lineHeight: 20 },
  budgetBox: { backgroundColor: C.cream, borderRadius: 14, padding: 16, alignItems: 'center' },
  budgetNote: { fontSize: 11, color: C.warmGray, marginBottom: 4 },
  budgetInputRow: { width: '100%', flexDirection: 'row', alignItems: 'center', backgroundColor: C.white, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 12 : 10, marginTop: 10, marginBottom: 12 },
  budgetInputPrefix: { fontSize: 18, fontWeight: '800', color: C.ink, marginRight: 8 },
  budgetInput: { flex: 1, fontSize: 16, fontWeight: '700', color: C.ink, padding: 0 },
  marketPriceCard: { width: '100%', backgroundColor: C.white, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12 },
  marketPriceLabel: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, color: C.warmGray },
  marketPriceValue: { fontSize: 14, fontWeight: '800', color: C.ink, marginTop: 4 },
  marketPriceSub: { fontSize: 11, color: C.warmGray, lineHeight: 16, marginTop: 4 },
  budgetAmount: { fontSize: 40, fontWeight: '800', color: C.ink, marginBottom: 12 },
  budgetControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, justifyContent: 'center', marginBottom: 10 },
  budgetChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white },
  budgetChipSelected: { borderColor: C.spice, backgroundColor: C.blush },
  budgetChipText: { fontSize: 11, fontWeight: '600', color: C.warmGray },
  budgetChipTextSelected: { color: C.spice },
  budgetRange: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  budgetRangeText: { fontSize: 10, color: C.warmGray },
  cookNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: C.paleGreen, borderRadius: 14, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: '#C3E6D3' },
  cookNoteIcon: { fontSize: 16 },
  cookNoteText: { flex: 1, fontSize: 12, color: '#2E7D5E', lineHeight: 18 },
  cookNoteStrong: { fontWeight: '800', color: C.mint },
  submitBtn: { backgroundColor: C.spice, borderRadius: 18, paddingVertical: 18, alignItems: 'center', shadowColor: C.spice, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  submitBtnText: { color: C.white, fontSize: 16, fontWeight: '800', letterSpacing: 0.2 },
  bottomSpacer: { height: 100 },
  settingsIcon: { fontSize: 18, color: C.ink },
  recentOrdersScroll: { paddingHorizontal: 18, gap: 10, paddingBottom: 4 },
  savedChefsScroll: { paddingHorizontal: 18, gap: 10, paddingBottom: 4 },
  orderCardWrap: { width: 240 },
  savedChefCard: {
    width: 154,
    backgroundColor: C.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    alignItems: 'center',
  },
  savedChefAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.spice,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    overflow: 'hidden',
  },
  savedChefAvatarImage: { width: '100%', height: '100%' },
  savedChefAvatarText: { color: C.white, fontSize: 22, fontWeight: '800' },
  savedChefName: { fontSize: 14, fontWeight: '800', color: C.ink, marginBottom: 4 },
  savedChefMeta: { fontSize: 11, color: C.warmGray, marginBottom: 8 },
  savedChefRatingPill: { backgroundColor: C.paleGreen, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8 },
  savedChefRatingText: { fontSize: 11, fontWeight: '800', color: C.mint },
  savedChefDish: { fontSize: 12, fontWeight: '600', color: C.warmGray, textAlign: 'center' },
  orderCard: { backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12 },
  orderTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  orderEmoji: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  orderEmojiText: { fontSize: 20 },
  orderInfo: { flex: 1 },
  orderName: { fontSize: 13, fontWeight: '700', color: C.ink },
  orderMeta: { fontSize: 10, color: C.warmGray, marginBottom: 4 },
  rateNow: { fontSize: 10, color: C.spice, fontWeight: '600' },
  orderRight: { alignItems: 'flex-end' },
  orderPrice: { fontSize: 14, fontWeight: '800', color: C.ink },
  orderStatus: { fontSize: 10, fontWeight: '600', marginTop: 2 },
  reorderBtn: { backgroundColor: C.cream, borderRadius: 8, paddingVertical: 7, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  reorderBtnText: { fontSize: 12, fontWeight: '600', color: C.ink },
  starRow: { flexDirection: 'row', gap: 2 },
  star: { fontSize: 11 },
  notifRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.white, marginHorizontal: 18, marginTop: 16, marginBottom: 4, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border },
  notifLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  menuGroup: { marginHorizontal: 18, marginTop: 16 },
  menuGroupTitle: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, color: C.warmGray, marginBottom: 8, paddingLeft: 2 },
  menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.white, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, marginBottom: 6 },
  savedAddressesBlock: { marginTop: 8, gap: 8 },
  savedAddressesTitle: { fontSize: 12, fontWeight: '800', color: C.ink, paddingLeft: 2, marginTop: 6 },
  savedAddressesHint: { fontSize: 12, color: C.warmGray, lineHeight: 18, paddingHorizontal: 2, paddingTop: 4 },
  savedAddressCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: C.white, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 12 },
  savedAddressIconWrap: { width: 36, height: 36, borderRadius: 12, backgroundColor: C.paleYellow, alignItems: 'center', justifyContent: 'center' },
  savedAddressIcon: { fontSize: 17, color: C.ink },
  savedAddressCopy: { flex: 1 },
  savedAddressLabel: { fontSize: 13, fontWeight: '800', color: C.ink, marginBottom: 4 },
  savedAddressText: { fontSize: 12, lineHeight: 18, color: C.warmGray },
  menuLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  menuIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  menuIconText: { fontSize: 16 },
  menuLabel: { fontSize: 13, fontWeight: '600', color: C.ink },
  menuSub: { fontSize: 10, color: C.warmGray, marginTop: 1 },
  menuRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  menuBadge: { backgroundColor: C.spice, borderRadius: 9, paddingHorizontal: 7, paddingVertical: 2, minWidth: 20, alignItems: 'center' },
  menuBadgeText: { color: C.white, fontSize: 10, fontWeight: '700' },
  menuArrow: { fontSize: 16, color: C.warmGray },
  chefBanner: { marginHorizontal: 18, marginTop: 20, backgroundColor: C.ink, borderRadius: 16, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 16 },
  chefBannerCopy: { flex: 1 },
  chefBannerTitle: { fontSize: 15, fontWeight: '700', color: C.white, lineHeight: 20 },
  chefBannerSub: { fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 },
  chefBannerBtn: { backgroundColor: C.turmeric, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  chefBannerBtnText: { color: C.white, fontSize: 12, fontWeight: '700' },
  signOutBtn: { margin: 18, paddingVertical: 13, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, alignItems: 'center' },
  signOutText: { fontSize: 14, fontWeight: '600', color: C.warmGray },
  newBadge: { backgroundColor: C.blush, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  newBadgeText: { fontSize: 12, fontWeight: '700', color: C.spice },
  quotesTopPad: { paddingHorizontal: 18, paddingTop: 14 },
  orderSummary: { backgroundColor: C.ink, borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  orderSummaryEmoji: { width: 52, height: 52, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  orderSummaryEmojiText: { fontSize: 28 },
  orderSummaryInfo: { flex: 1 },
  orderSummaryName: { fontSize: 17, fontWeight: '800', color: C.white, letterSpacing: -0.3 },
  orderSummarySub: { fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 3 },
  orderSummaryBudget: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  orderSummaryBudgetNum: { fontSize: 18, fontWeight: '800', color: C.turmeric },
  orderSummaryBudgetLabel: { fontSize: 9, fontWeight: '700', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 3 },
  quotesHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 10 },
  quotesCount: { fontSize: 11, color: C.warmGray },
  quoteCard: { marginHorizontal: 18, marginBottom: 12, backgroundColor: C.white, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 16, shadowColor: C.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 3 },
  quoteCardBest: { borderColor: C.mint, borderWidth: 1.5, backgroundColor: '#F7FEFB' },
  qcTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  qcChef: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  qcChefInfo: { flex: 1 },
  chefAv: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  chefAvText: { color: C.white, fontWeight: '800', fontSize: 17 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  chefName: { fontSize: 15, fontWeight: '800', color: C.ink, letterSpacing: -0.2 },
  chefMeta: { fontSize: 11, color: C.warmGray, marginTop: 3 },
  bestBadge: { backgroundColor: C.paleGreen, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: '#C3E6D3' },
  bestBadgeText: { fontSize: 9, fontWeight: '800', color: C.mint, textTransform: 'uppercase', letterSpacing: 0.6 },
  qcPrice: { fontSize: 22, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  qcMid: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  detailPill: { flex: 1, backgroundColor: C.cream, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 10, alignItems: 'center' },
  detailVal: { fontSize: 13, fontWeight: '700', color: C.ink, marginBottom: 2, textAlign: 'center' },
  detailSub: { fontSize: 10, color: C.warmGray, textAlign: 'center' },
  qcCounterRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 14, paddingHorizontal: 2 },
  qcCounterMeta: { flex: 1, fontSize: 11, fontWeight: '600', color: C.warmGray },
  qcActions: { gap: 10 },
  qcSecondaryActions: { flexDirection: 'row', gap: 8 },
  btnAccept: { paddingVertical: 14, borderRadius: 14, alignItems: 'center', backgroundColor: C.mint, shadowColor: C.mint, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3 },
  btnAcceptText: { color: C.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.1 },
  btnCounter: { flex: 1, paddingVertical: 11, borderRadius: 12, borderWidth: 1.5, borderColor: C.mint, alignItems: 'center', backgroundColor: C.paleGreen },
  btnCounterText: { fontSize: 13, fontWeight: '700', color: C.mint },
  btnReject: { flex: 1, paddingVertical: 11, borderRadius: 12, borderWidth: 1.5, borderColor: '#F5C0C0', backgroundColor: '#FFF5F5', alignItems: 'center' },
  btnRejectText: { fontSize: 13, fontWeight: '700', color: '#E53E3E' },
  raiseStrip: { marginHorizontal: 18, marginBottom: 12, backgroundColor: C.blush, borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderWidth: 1, borderColor: '#F5D0C0' },
  raiseTitle: { fontSize: 13, fontWeight: '800', color: C.spice, marginBottom: 2 },
  raiseSub: { fontSize: 11, color: '#C07050', lineHeight: 16 },
  raiseBtn: { backgroundColor: C.spice, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, shadowColor: C.spice, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3 },
  raiseBtnText: { color: C.white, fontSize: 13, fontWeight: '800' },
  tipBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginHorizontal: 18, marginBottom: 16, backgroundColor: C.paleGreen, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#C3E6D3' },
  tipIcon: { fontSize: 16 },
  tipText: { flex: 1, fontSize: 12, color: '#2E7D5E', lineHeight: 18 },
});

const authSt = StyleSheet.create({
  bootWrap: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, backgroundColor: C.cream, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  bootBadge: { backgroundColor: C.ink, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 16 },
  bootBadgeText: { color: C.turmeric, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  bootTitle: { fontSize: 24, fontWeight: '800', color: C.ink, textAlign: 'center' },
  bootSub: { marginTop: 8, fontSize: 13, lineHeight: 20, color: C.warmGray, textAlign: 'center' },
  scrollContent: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 48 },
  brand: { alignItems: 'center', marginTop: 56, marginBottom: 28 },
  brandIcon: { width: 72, height: 72, borderRadius: 18, marginBottom: 14 },
  brandRow: { flexDirection: 'row', alignItems: 'baseline' },
  brandFood: { fontSize: 38, fontWeight: '900', color: C.ink, letterSpacing: -1 },
  brandSood: { fontSize: 38, fontWeight: '900', color: C.spice, letterSpacing: -1 },
  brandTagline: { marginTop: 8, fontSize: 15, color: C.warmGray, fontWeight: '500' },
  card: { backgroundColor: C.white, borderRadius: 24, padding: 22, shadowColor: 'rgba(26,38,32,0.08)', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 1, shadowRadius: 20, elevation: 4 },
  stepLabel: { fontSize: 13, fontWeight: '800', color: C.ink, marginBottom: 10, letterSpacing: 0.2 },
  stepSub: { fontSize: 13, color: C.warmGray, marginBottom: 16 },
  emailHighlight: { color: C.ink, fontWeight: '700' },
  emailInput: { backgroundColor: C.cream, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, color: C.ink, marginBottom: 4 },
  otpInput: { backgroundColor: C.cream, borderRadius: 16, borderWidth: 1.5, borderColor: C.border, paddingVertical: 18, fontSize: 32, fontWeight: '800', color: C.ink, letterSpacing: 14, marginBottom: 4 },
  submitBtn: { backgroundColor: C.ink, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 14, marginBottom: 4 },
  submitBtnText: { color: C.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
  footNote: { fontSize: 12, color: C.warmGray, lineHeight: 18, marginTop: 10 },
  resendRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  switchLink: { color: C.spice, fontWeight: '700', fontSize: 13 },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#44584E', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 },
  nameRow: { flexDirection: 'row', gap: 10 },
  locRow: { flexDirection: 'row', alignItems: 'center' },
  gpsBtn: { backgroundColor: C.paleGreen, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginTop: 14 },
  gpsBtnText: { fontSize: 12, fontWeight: '700', color: C.mint },
  gpsLabel: { fontSize: 12, color: C.mint, fontWeight: '600', marginTop: 4, marginBottom: 2 },
  // unused legacy keys kept to avoid TS errors on other screens
  modeRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  modeBtn: { flex: 1, borderRadius: 12, alignItems: 'center', paddingVertical: 12 },
  modeBtnActive: { backgroundColor: C.white },
  modeText: { fontSize: 14, fontWeight: '600', color: C.warmGray },
  modeTextActive: { color: C.ink, fontWeight: '700' },
  switchText: { textAlign: 'center', fontSize: 13, color: C.warmGray },
});

const orderTabSt = StyleSheet.create({
  summaryRow: { flexDirection: 'row', gap: 10, marginHorizontal: 18, marginTop: 18, marginBottom: 18 },
  summaryTile: {
    flex: 1,
    minHeight: 96,
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 16,
    justifyContent: 'space-between',
    shadowColor: 'rgba(26,38,32,0.08)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 3,
  },
  summaryValue: { fontSize: 24, fontWeight: '900', color: C.ink, letterSpacing: -0.6 },
  summaryLabel: { fontSize: 11, lineHeight: 15, color: '#44584E', fontWeight: '700' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 18, marginBottom: 10, marginTop: 8 },
  sectionEmoji: { fontSize: 16, marginRight: 8 },
  sectionTitle: { flex: 1, fontSize: 16, fontWeight: '800', color: '#1A2620', letterSpacing: -0.3 },
  sectionBadge: { minWidth: 28, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, backgroundColor: '#1D6B54', alignItems: 'center' },
  sectionBadgeText: { color: C.white, fontSize: 11, fontWeight: '800' },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    marginHorizontal: 18,
    marginBottom: 18,
    paddingHorizontal: 20,
    paddingVertical: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E8ECE5',
    shadowColor: 'rgba(26,38,32,0.06)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 2,
  },
  emptyEmoji: { fontSize: 30, marginBottom: 10 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: '#1A2620', textAlign: 'center' },
  emptySub: { fontSize: 12, color: '#6E7F75', textAlign: 'center', marginTop: 8, lineHeight: 18 },
  pendingCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#ECE4C7',
    marginHorizontal: 18,
    marginBottom: 12,
    padding: 16,
    shadowColor: 'rgba(180,120,0,0.08)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 2,
  },
  holdCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#F1DED5',
    marginHorizontal: 18,
    marginBottom: 12,
    padding: 16,
    shadowColor: 'rgba(244,130,74,0.08)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 2,
  },
  placedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#E1EEE7',
    marginHorizontal: 18,
    marginBottom: 12,
    padding: 16,
    shadowColor: 'rgba(46,139,110,0.08)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
    elevation: 2,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center' },
  emojiWrap: { width: 54, height: 54, borderRadius: 18, backgroundColor: '#FFF4EC', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  emojiText: { fontSize: 26 },
  cardInfo: { flex: 1, paddingRight: 10 },
  cardName: { fontSize: 15, fontWeight: '800', color: '#1A2620' },
  cardMeta: { fontSize: 12, color: '#6E7F75', marginTop: 4, fontWeight: '600' },
  placedTop: { flexDirection: 'row', alignItems: 'center' },
  placedEmojiWrap: { width: 54, height: 54, borderRadius: 18, backgroundColor: '#FFF4EC', alignItems: 'center', justifyContent: 'center' },
  placedEmoji: { fontSize: 26 },
  placedInfo: { flex: 1, marginLeft: 12, paddingRight: 10 },
  placedName: { fontSize: 15, fontWeight: '800', color: '#1A2620' },
  placedMeta: { fontSize: 12, color: '#6E7F75', marginTop: 4, fontWeight: '600' },
  placedTime: { fontSize: 11, color: '#2E8B6E', marginTop: 6, fontWeight: '700' },
  cookingTimer: { fontSize: 11, color: '#D46F3F', marginTop: 6, fontWeight: '800' },
  holdTime: { fontSize: 11, color: '#D46F3F', marginTop: 6, fontWeight: '700' },
  pendingTime: { fontSize: 11, color: '#B07800', marginTop: 6, fontWeight: '700' },
  holdBadge: { backgroundColor: '#FFF3DD', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, minWidth: 64, alignItems: 'center' },
  holdBadgeText: { fontSize: 10, fontWeight: '800', color: '#C07A12', letterSpacing: 0.5 },
  pendingBadge: { backgroundColor: '#FFF7D8', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, minWidth: 68, alignItems: 'center' },
  pendingBadgeText: { fontSize: 10, fontWeight: '800', color: '#B07800', letterSpacing: 0.5, textTransform: 'uppercase' },
  placedBadge: { backgroundColor: '#E3F6EC', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, minWidth: 76, alignItems: 'center' },
  placedBadgeText: { fontSize: 10, fontWeight: '800', color: '#1D6B54', letterSpacing: 0.5, textTransform: 'uppercase' },
  placedFooter: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#EEF1EC', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  placedFooterLabel: { fontSize: 11, color: '#7B877F', flex: 1, paddingRight: 10 },
  placedFooterValue: { fontSize: 19, fontWeight: '900', color: '#1A2620', letterSpacing: -0.4 },
  advanceBadge: { fontSize: 11, color: '#B07800', fontWeight: '700', marginTop: 3 },
  payBalanceBtn: { marginTop: 10, backgroundColor: '#1D6B54', borderRadius: 14, paddingVertical: 11, alignItems: 'center' },
  payBalanceBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.2 },
  historyWrap: { marginBottom: 2 },
  payBtn: {
    marginTop: 14,
    backgroundColor: '#F4824A',
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: '#F4824A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 14,
    elevation: 3,
  },
  payBtnText: { color: C.white, fontSize: 13, fontWeight: '800', letterSpacing: 0.2 },
  checkoutSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 30 },
  checkoutTitle: { fontSize: 20, fontWeight: '800', color: C.ink },
  checkoutSub: { fontSize: 13, color: '#6E7F75', marginTop: 6, lineHeight: 19 },
  checkoutTimer: { fontSize: 12, color: '#D46F3F', fontWeight: '700', marginTop: 8 },
  checkoutLabel: { fontSize: 12, fontWeight: '800', color: '#1A2620', marginTop: 18, marginBottom: 10, letterSpacing: 0.4 },
  deliveryRow: { flexDirection: 'row', gap: 10 },
  deliveryChip: { flex: 1, borderRadius: 16, borderWidth: 1, borderColor: '#E3E8E0', paddingVertical: 13, alignItems: 'center', backgroundColor: '#F7FAF5' },
  deliveryChipActive: { backgroundColor: '#DFF3EA', borderColor: '#2E8B6E' },
  deliveryChipText: { fontSize: 12, fontWeight: '700', color: '#6E7F75' },
  deliveryChipTextActive: { color: '#1D6B54' },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 2 },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: '#D7DFD7', backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' },
  checkboxActive: { borderColor: '#2E8B6E', backgroundColor: '#DFF3EA' },
  checkboxTick: { color: '#1D6B54', fontSize: 13, fontWeight: '800' },
  checkboxLabel: { fontSize: 12, color: '#1A2620', fontWeight: '600' },
  demoPayCard: { marginTop: 16, backgroundColor: '#EEF6F1', borderRadius: 20, padding: 16 },
  demoPayLabel: { fontSize: 11, fontWeight: '800', color: '#2E8B6E', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  demoPayAmount: { fontSize: 30, fontWeight: '900', color: '#1A2620', marginTop: 6, letterSpacing: -0.8 },
  demoPaySub: { fontSize: 11, color: '#6E7F75', marginTop: 10, textAlign: 'center' },
  payBreakdown: { gap: 6 },
  payRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  payRowLabel: { fontSize: 13, color: '#6E7F75' },
  payRowValue: { fontSize: 13, fontWeight: '700', color: '#1A2620' },
  payDiscountLabel: { fontSize: 13, color: '#16A34A' },
  payDiscountValue: { fontSize: 13, fontWeight: '700', color: '#16A34A' },
  payDivider: { height: 1, backgroundColor: 'rgba(46,139,110,0.12)', marginVertical: 6 },
  payTotalLabel: { fontSize: 15, fontWeight: '800', color: '#1A2620' },
  payTotalValue: { fontSize: 19, fontWeight: '900', color: '#1A2620' },
});

const reviewPromptSt = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(26,18,9,0.42)', justifyContent: 'flex-end', padding: 18 },
  sheet: { backgroundColor: C.white, borderRadius: 24, padding: 20, borderWidth: 1, borderColor: C.border },
  badge: { alignSelf: 'flex-start', backgroundColor: C.paleGreen, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 12 },
  badgeText: { fontSize: 10, fontWeight: '800', color: C.mint, letterSpacing: 0.8 },
  title: { fontSize: 22, fontWeight: '900', color: C.ink, letterSpacing: -0.4 },
  sub: { fontSize: 13, color: C.warmGray, lineHeight: 20, marginTop: 8 },
  label: { fontSize: 11, fontWeight: '700', color: C.ink, marginTop: 18, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.6 },
  starRow: { flexDirection: 'row', gap: 8 },
  star: { fontSize: 32, color: C.border },
  starActive: { color: C.turmeric },
  input: { minHeight: 110, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.cream, paddingHorizontal: 14, paddingVertical: 14, fontSize: 14, color: C.ink },
  submitBtn: { marginTop: 18, backgroundColor: C.spice, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  submitBtnText: { color: C.white, fontSize: 14, fontWeight: '800' },
  snoozeBtn: { marginTop: 10, borderRadius: 14, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.white },
  snoozeBtnText: { color: C.warmGray, fontSize: 13, fontWeight: '700' },
});

const notifSheetSt = StyleSheet.create({
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28 },
  handle: { alignSelf: 'center', width: 42, height: 5, borderRadius: 3, backgroundColor: '#D9D3CB', marginBottom: 16 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  emojiWrap: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  emoji: { fontSize: 28 },
  title: { fontSize: 20, fontWeight: '800', color: '#1A2620', letterSpacing: -0.4 },
  sub: { marginTop: 4, fontSize: 12, color: '#6E7F75', fontWeight: '600' },
  statusPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, marginLeft: 10 },
  statusText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  priceRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  priceCard: { flex: 1, backgroundColor: '#F7FAF5', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 14, borderWidth: 1, borderColor: '#E4ECE6' },
  priceLabel: { fontSize: 11, fontWeight: '800', color: '#6E7F75', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  priceValue: { fontSize: 20, fontWeight: '900', color: '#1A2620', letterSpacing: -0.5 },
  priceMeta: { fontSize: 13, fontWeight: '700', color: '#2E8B6E', lineHeight: 18 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  tag: { backgroundColor: '#FFF4EC', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  tagText: { fontSize: 12, fontWeight: '700', color: '#D46F3F' },
  detailCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, borderWidth: 1, borderColor: '#E9EEE7', marginBottom: 14 },
  detailTitle: { fontSize: 13, fontWeight: '800', color: '#1A2620', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  detailLine: { fontSize: 13, color: '#44584E', fontWeight: '600', marginBottom: 8 },
  detailNote: { marginTop: 4, fontSize: 13, lineHeight: 19, color: '#6E7F75' },
  payBtn: { marginTop: 2, marginBottom: 10, backgroundColor: C.mint, borderRadius: 18, paddingVertical: 14, alignItems: 'center' },
  payBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  actionRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  counterBtn: { flex: 1, backgroundColor: '#FFF4EC', borderRadius: 18, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#F3D2BF' },
  counterBtnText: { color: '#D46F3F', fontSize: 14, fontWeight: '800' },
  rejectBtn: { flex: 1, backgroundColor: '#FFF5F5', borderRadius: 18, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#F5C5C5' },
  rejectBtnText: { color: '#D94B4B', fontSize: 14, fontWeight: '800' },
  closeBtn: { marginTop: 4, backgroundColor: '#F4824A', borderRadius: 18, paddingVertical: 14, alignItems: 'center' },
  closeBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});

const profileSt = StyleSheet.create({
  hero: { backgroundColor: C.blush, alignItems: 'center', paddingTop: 24, paddingBottom: 28, paddingHorizontal: 18, position: 'relative' },
  settingsBtn: { position: 'absolute', top: 16, right: 16, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.6)', alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 68, height: 68, borderRadius: 34, backgroundColor: C.spice, alignItems: 'center', justifyContent: 'center', marginBottom: 12, shadowColor: C.spice, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 4 },
  avatarText: { color: C.white, fontWeight: '800', fontSize: 28 },
  name: { fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  location: { fontSize: 12, color: C.warmGray, marginTop: 4 },
  member: { fontSize: 11, color: '#B0A8A0', marginTop: 2, marginBottom: 14 },
  editBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, backgroundColor: C.white, borderWidth: 1, borderColor: C.border },
  editBtnText: { fontSize: 12, fontWeight: '600', color: C.ink },
  statsRow: { flexDirection: 'row', backgroundColor: C.white, marginHorizontal: 18, marginTop: -16, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: C.border, shadowColor: C.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, marginBottom: 20 },
  statBox: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  statNum: { fontSize: 17, fontWeight: '800', color: C.ink },
  statLabel: { fontSize: 9, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, color: C.warmGray, marginTop: 2 },
  divider: { width: 1, height: '60%', backgroundColor: C.border, alignSelf: 'center' },
});

const feedSt = StyleSheet.create({
  tabBar: { flexDirection: 'row', backgroundColor: '#ECF0EA', borderRadius: 22, padding: 4, marginBottom: 16, position: 'relative', overflow: 'hidden' },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 18, alignItems: 'center' },
  tabActive: { backgroundColor: C.white },
  tabText: { fontSize: 13, fontWeight: '700', color: '#8B948B' },
  tabTextActive: { color: '#1A2620' },
  // What's Cooking card — clean horizontal layout
  cookCard: {
    borderRadius: 20, marginBottom: 14, backgroundColor: C.white,
    borderWidth: 1, borderColor: C.border,
    shadowColor: C.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.07, shadowRadius: 10, elevation: 4,
    overflow: 'visible',
  },
  cookRow: { flexDirection: 'row', padding: 14, gap: 14 },
  cookImgBox: {
    width: 84, height: 84, borderRadius: 16, backgroundColor: C.paleGreen,
    alignItems: 'center', justifyContent: 'center', overflow: 'visible', position: 'relative',
  },
  cookImgFull: { width: 84, height: 84, borderRadius: 16 },
  cookImgEmoji: { fontSize: 36 },
  cookEtaBadge: {
    position: 'absolute', bottom: -9, alignSelf: 'center',
    backgroundColor: C.turmeric, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 2, borderColor: C.white,
  },
  cookEtaBadgeReady: { backgroundColor: C.mint },
  cookEtaText: { fontSize: 10, fontWeight: '800', color: C.white, letterSpacing: 0.3 },
  cookInfo: { flex: 1, justifyContent: 'center', gap: 5 },
  cookDish: { fontSize: 16, fontWeight: '800', color: C.ink, lineHeight: 21, letterSpacing: -0.3 },
  cookChefRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  cookAvatar: {
    width: 18, height: 18, borderRadius: 9, backgroundColor: C.paleGreen,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#C3E6D3',
  },
  cookAvatarText: { fontSize: 9, color: C.mint, fontWeight: '800' },
  cookChefName: { fontSize: 12, color: C.warmGray, fontWeight: '600' },
  cookDot: { fontSize: 10, color: C.border },
  cookDist: { fontSize: 12, color: C.mint, fontWeight: '700' },
  cookTagsLine: { fontSize: 11, color: C.warmGray, fontWeight: '500' },
  cookDivider: { height: 1, backgroundColor: C.border, marginHorizontal: 14 },
  cookFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12 },
  cookFooterLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cookFooterRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cookMetaItem: { fontSize: 12, color: C.warmGray, fontWeight: '500' },
  cookRatingBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.paleGreen, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3 },
  cookRatingBadgeText: { fontSize: 11, fontWeight: '800', color: C.mint },
  cookPrice: { fontSize: 15, fontWeight: '800', color: C.ink },
  cookCta: { backgroundColor: C.mint, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9 },
  cookCtaPreOrder: { backgroundColor: '#7C3AED' },
  cookCtaText: { color: C.white, fontSize: 12, fontWeight: '800', letterSpacing: 0.2 },
  cookCtaSent: { backgroundColor: C.paleGreen, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, alignItems: 'center' },
  cookCtaSentText: { color: C.mint, fontSize: 12, fontWeight: '800' },
  geoBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#DFF3EA', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14 },
  geoBannerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, paddingRight: 10 },
  geoBannerIcon: { fontSize: 15, marginRight: 8 },
  geoBannerText: { fontSize: 12, color: '#2E8B6E', fontWeight: '700', flex: 1 },
  geoBannerEdit: { fontSize: 12, color: '#1D6B54', fontWeight: '800' },
  empty: { alignItems: 'center', paddingVertical: 36 },
  emptyEmoji: { fontSize: 36, marginBottom: 10 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 6 },
  emptySub: { fontSize: 13, color: C.warmGray, textAlign: 'center' },
});

const homeFx = StyleSheet.create({
  particle: { position: 'absolute', top: 20, fontSize: 16 },
  pulseRing: {
    position: 'absolute',
    width: 108,
    height: 52,
    borderRadius: 18,
    backgroundColor: 'rgba(244,130,74,0.18)',
  },
  banner: {
    marginBottom: 16,
    borderRadius: 28,
    overflow: 'hidden',
    minHeight: 172,
    shadowColor: 'rgba(46,139,110,0.15)',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 5,
  },
  bannerBg: { ...StyleSheet.absoluteFillObject, backgroundColor: '#141E1A' },
  bannerBlob1: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(78,189,150,0.16)',
    top: -70,
    right: -30,
  },
  bannerBlob2: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(212,245,233,0.08)',
    bottom: -40,
    left: 40,
  },
  bannerContent: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 22 },
  bannerCopy: { flex: 1, paddingRight: 12 },
  bannerPill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 10, paddingVertical: 6, marginBottom: 12 },
  bannerPillDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#F4A623', marginRight: 6 },
  bannerPillText: { color: '#F4C25B', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  bannerTitle: { color: '#FFFFFF', fontSize: 18, lineHeight: 23, fontWeight: '800', letterSpacing: -0.5, marginBottom: 8 },
  bannerSub: { color: 'rgba(255,255,255,0.72)', fontSize: 12, fontWeight: '600' },
  bannerAction: { justifyContent: 'center' },
  ctaWrap: { width: 108, height: 52, alignItems: 'center', justifyContent: 'center' },
  ctaBtn: { width: 108, height: 52, borderRadius: 18, backgroundColor: '#F4824A', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', shadowColor: '#F4824A', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 14, elevation: 4 },
  ctaBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  ctaBtnArrow: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', marginLeft: 6 },
  tabBar: { flexDirection: 'row', backgroundColor: '#E9EEE7', borderRadius: 22, padding: 4, marginBottom: 14, position: 'relative', overflow: 'hidden' },
  tabSlider: { position: 'absolute', top: 4, bottom: 4, left: 2, backgroundColor: '#FFFFFF', borderRadius: 18, shadowColor: 'rgba(26,38,32,0.1)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 2 },
  tabBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, zIndex: 1 },
  tabBadge: { position: 'absolute', top: 8, right: 18, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: '#E53E3E', alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  tabBadgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
  tabText: { fontSize: 13, fontWeight: '700', color: '#90988F' },
  tabTextActive: { color: '#1A2620' },
  emptyWrap: { alignItems: 'center', paddingTop: 36, paddingBottom: 18 },
  rippleWrap: { width: 144, height: 144, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  rippleRing: { position: 'absolute', borderRadius: 999, borderWidth: 1 },
  rippleOuter: { width: 126, height: 126, borderColor: 'rgba(46,139,110,0.14)', backgroundColor: 'rgba(212,245,233,0.18)' },
  rippleInner: { width: 98, height: 98, borderColor: 'rgba(46,139,110,0.18)', backgroundColor: 'rgba(212,245,233,0.28)' },
  bellCircle: { width: 74, height: 74, borderRadius: 37, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', shadowColor: 'rgba(46,139,110,0.18)', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 3 },
  bellEmoji: { fontSize: 32 },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: '#1A2620', marginBottom: 8 },
  emptySub: { fontSize: 13, lineHeight: 19, color: '#74857B', textAlign: 'center', paddingHorizontal: 24 },
  hintRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  hintCard: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 18, paddingVertical: 14, paddingHorizontal: 10, alignItems: 'center', shadowColor: 'rgba(46,139,110,0.08)', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 2 },
  hintIcon: { fontSize: 18, marginBottom: 6 },
  hintText: { fontSize: 11, fontWeight: '700', color: '#486256', textAlign: 'center' },
});

const exploreSt = StyleSheet.create({
  hero: {
    marginHorizontal: 18,
    marginTop: 18,
    marginBottom: 14,
    backgroundColor: '#FFFFFF',
    borderRadius: 26,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4ECE6',
    shadowColor: 'rgba(46,139,110,0.08)',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 3,
  },
  heroTextWrap: { flex: 1, paddingRight: 12 },
  heroKicker: { fontSize: 10, fontWeight: '800', color: '#2E8B6E', letterSpacing: 1 },
  heroTitle: { marginTop: 8, fontSize: 20, lineHeight: 25, fontWeight: '800', color: '#1A2620', letterSpacing: -0.5 },
  heroSub: { marginTop: 8, fontSize: 12, lineHeight: 18, color: '#6E7F75', fontWeight: '600' },
  heroBadge: { width: 64, height: 64, borderRadius: 22, backgroundColor: '#DFF3EA', alignItems: 'center', justifyContent: 'center' },
  heroBadgeEmoji: { fontSize: 30 },
  statsRow: { flexDirection: 'row', gap: 10, marginHorizontal: 18, marginBottom: 16 },
  statCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#E4ECE6',
  },
  statValue: { fontSize: 22, fontWeight: '900', color: '#1A2620', letterSpacing: -0.5 },
  statLabel: { marginTop: 4, fontSize: 12, fontWeight: '700', color: '#6E7F75' },
});

const locSt = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  modalWrap: { justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingBottom: 32, maxHeight: '80%' },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10, marginBottom: 16 },
  title: { fontSize: 16, fontWeight: '700', color: C.ink, marginBottom: 14 },
  content: { paddingBottom: 8 },
  searchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F2ED', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, gap: 8, marginBottom: 12 },
  searchIcon: { fontSize: 14 },
  searchInput: { flex: 1, fontSize: 14, color: C.ink, padding: 0 },
  clearBtn: { fontSize: 13, color: C.warmGray, paddingHorizontal: 4 },
  gpsBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.paleGreen, borderRadius: 12, padding: 14, marginBottom: 14 },
  gpsIcon: { fontSize: 20 },
  gpsBtnText: { fontSize: 14, fontWeight: '700', color: C.mint },
  gpsBtnSub: { fontSize: 11, color: C.warmGray, marginTop: 1 },
  radiusBox: { backgroundColor: '#F5F2ED', borderRadius: 12, padding: 14, marginBottom: 14 },
  radiusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  radiusLabel: { fontSize: 13, fontWeight: '600', color: C.ink },
  radiusValue: { fontSize: 15, fontWeight: '800', color: C.mint },
  slider: { width: '100%', height: 36 },
  radiusTicks: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  radiusTick: { fontSize: 10, color: C.warmGray },
  radiusHint: { fontSize: 11, color: C.warmGray, marginTop: 6, textAlign: 'center' },
  mapCard: { marginBottom: 14, borderRadius: 16, overflow: 'hidden', backgroundColor: '#F5F2ED', borderWidth: 1, borderColor: C.border },
  mapFrame: { width: '100%', height: 170, backgroundColor: '#F5F2ED' },
  mapCaption: { paddingHorizontal: 12, paddingVertical: 10 },
  mapCaptionTitle: { fontSize: 13, fontWeight: '800', color: C.ink },
  mapCaptionSub: { fontSize: 11, color: C.warmGray, marginTop: 3 },
  mapPopupBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  mapPopupSheet: { backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingBottom: 22, paddingTop: 6, minHeight: '68%' },
  mapPopupSub: { fontSize: 12, lineHeight: 18, color: C.warmGray, marginBottom: 14 },
  mapPopupCard: { borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: C.border, backgroundColor: '#F5F2ED', height: 340, marginBottom: 14 },
  mapPopupFrame: { width: '100%', height: '100%', backgroundColor: '#F5F2ED' },
  fixedPinWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  fixedPin: { fontSize: 34, marginTop: -18 },
  mapRadiusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  mapRadiusControls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mapRadiusBtn: { width: 36, height: 36, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: '#F9F7F2', alignItems: 'center', justifyContent: 'center' },
  mapRadiusBtnText: { fontSize: 22, lineHeight: 24, fontWeight: '700', color: C.ink },
  mapRadiusValuePill: { minWidth: 72, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: C.paleGreen, alignItems: 'center' },
  mapRadiusValueText: { fontSize: 12, fontWeight: '800', color: C.mint },
  mapCoordsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F9F7F2', borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14 },
  mapCoordsLabel: { fontSize: 12, fontWeight: '700', color: C.ink },
  mapCoordsValue: { fontSize: 12, color: C.mint, fontWeight: '700' },
  mapPopupActions: { flexDirection: 'row', gap: 10 },
  mapCancelBtn: { flex: 1, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 14, alignItems: 'center', backgroundColor: '#F9F7F2' },
  mapCancelText: { fontSize: 13, fontWeight: '700', color: C.warmGray },
  mapConfirmBtn: { flex: 1.4, borderRadius: 14, paddingVertical: 14, alignItems: 'center', backgroundColor: C.spice, shadowColor: C.spice, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4 },
  mapConfirmText: { fontSize: 13, fontWeight: '800', color: C.white },
  addressCard: { backgroundColor: '#F9F7F2', borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12, marginBottom: 12, gap: 10 },
  addressLabelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: C.ink },
  fieldInput: { borderWidth: 1, borderColor: '#E4DED2', borderRadius: 12, backgroundColor: C.white, paddingHorizontal: 12, paddingVertical: 11, fontSize: 13, color: C.ink },
  fieldInputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  photoBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#E4DED2', borderRadius: 12, backgroundColor: C.white, padding: 10 },
  photoPlaceholder: { width: 56, height: 56, borderRadius: 14, backgroundColor: C.paleBlue, alignItems: 'center', justifyContent: 'center' },
  photoIcon: { fontSize: 24 },
  photoPreview: { width: 56, height: 56, borderRadius: 14 },
  photoCopy: { flex: 1 },
  photoTitle: { fontSize: 13, fontWeight: '700', color: C.ink },
  photoSub: { fontSize: 11, color: C.warmGray, marginTop: 2, lineHeight: 16 },
  list: { maxHeight: 420 },
  listItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, gap: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  listItemActive: { backgroundColor: C.paleGreen, borderRadius: 10, paddingHorizontal: 8, marginHorizontal: -8 },
  listItemIcon: { fontSize: 16 },
  listItemName: { fontSize: 14, fontWeight: '600', color: C.ink },
  listItemNameActive: { color: C.mint },
  listItemSub: { fontSize: 11, color: C.warmGray, marginTop: 1 },
  saveBtn: { backgroundColor: C.spice, borderRadius: 14, alignItems: 'center', paddingVertical: 15, marginTop: 14, marginBottom: 8, shadowColor: C.spice, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4 },
  saveBtnText: { color: C.white, fontSize: 14, fontWeight: '800' },
});

const chefSt = StyleSheet.create({
  // Header
  saveBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: C.spice },
  saveBtnText: { color: C.white, fontSize: 12, fontWeight: '700' },

  // Cover photo
  cover: { width: '100%', height: 180, backgroundColor: '#F3EDE5', borderBottomWidth: 1, borderBottomColor: C.border, overflow: 'hidden', position: 'relative' },
  coverImg: { width: '100%', height: '100%', resizeMode: 'cover' },
  coverPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  coverIcon: { fontSize: 38 },
  coverLabel: { fontSize: 15, fontWeight: '700', color: C.ink },
  coverSub: { fontSize: 12, color: C.warmGray },
  coverBadge: { position: 'absolute', bottom: 10, right: 12, backgroundColor: 'rgba(26,18,9,0.55)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  coverBadgeText: { color: C.white, fontSize: 11, fontWeight: '600' },

  // Hero row
  heroRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: C.spice, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: C.white, shadowColor: C.ink, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.14, shadowRadius: 8, elevation: 3 },
  avatarText: { color: C.white, fontSize: 28, fontWeight: '800' },
  avatarCam: { position: 'absolute', bottom: 0, right: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.white },
  heroInfo: { flex: 1, paddingBottom: 4 },
  heroName: { fontSize: 20, fontWeight: '800', color: C.ink, letterSpacing: -0.4 },
  heroLoc: { fontSize: 12, color: C.warmGray, marginTop: 2, marginBottom: 5 },
  heroMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  heroStar: { fontSize: 12, fontWeight: '700', color: C.ink },
  heroDot: { fontSize: 14, color: C.border },
  heroMeta: { fontSize: 12, color: C.warmGray, fontWeight: '500' },

  // Availability
  availRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: 18, marginBottom: 6, backgroundColor: C.white, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border },
  availLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  availDot: { width: 10, height: 10, borderRadius: 5 },
  availTitle: { fontSize: 14, fontWeight: '700', color: C.ink },
  availSub: { fontSize: 11, color: C.warmGray, marginTop: 1 },

  // Stats
  statsRow: { flexDirection: 'row', marginHorizontal: 18, marginBottom: 4, backgroundColor: C.white, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  statItem: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  statDivider: { borderRightWidth: 1, borderRightColor: C.border },
  statNum: { fontSize: 14, fontWeight: '800', color: C.ink },
  statLabel: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, color: C.warmGray, marginTop: 2 },
  statSub: { fontSize: 9, color: C.warmGray, marginTop: 1 },

  // Generic section
  section: { paddingHorizontal: 18, paddingVertical: 16, borderTopWidth: 1, borderTopColor: C.border },
  secRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  secTitle: { fontSize: 14, fontWeight: '700', color: C.ink },
  addBtn: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 8, backgroundColor: C.cream, borderWidth: 1, borderColor: C.border },
  addBtnText: { fontSize: 12, fontWeight: '600', color: C.ink },
  hint: { fontSize: 10, color: C.warmGray, marginTop: 7 },

  // Culinary expertise chips
  expertiseChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: C.blush, borderWidth: 1.5, borderColor: '#F3C2AD' },
  expertiseChipText: { fontSize: 12, fontWeight: '600', color: C.spice },
  expertiseX: { fontSize: 15, color: C.spice, fontWeight: '600', lineHeight: 18 },

  // Signature dishes
  dishGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dishChip: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: C.cream, borderWidth: 1, borderColor: C.border },
  dishEmoji: { fontSize: 16 },
  dishName: { fontSize: 12, fontWeight: '600', color: C.ink },

  // Bio
  bioText: { fontSize: 13, color: C.ink, lineHeight: 21 },
  bioInput: { backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, padding: 12, fontSize: 13, color: C.ink, lineHeight: 20, minHeight: 100 },

  // Gallery
  galleryCount: { fontSize: 11, color: C.warmGray },
  gallery: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  galleryImg: { borderRadius: 10 },
  galleryAdd: { borderRadius: 10, backgroundColor: C.cream, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.border, alignItems: 'center', justifyContent: 'center', gap: 4 },
  galleryAddIcon: { fontSize: 26, color: C.warmGray, fontWeight: '300', lineHeight: 30 },
  galleryAddText: { fontSize: 10, color: C.warmGray, fontWeight: '600' },
  galleryEmpty: { flex: 1, backgroundColor: C.cream, borderRadius: 10, padding: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: C.border },
  galleryEmptyText: { fontSize: 12, color: C.warmGray, lineHeight: 18 },

  // Reviews
  ratingPill: { backgroundColor: C.paleYellow, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  ratingPillText: { fontSize: 11, fontWeight: '700', color: '#B07800' },
  reviewCard: { backgroundColor: C.white, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border, marginBottom: 8 },
  reviewTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  reviewAv: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.blush, alignItems: 'center', justifyContent: 'center' },
  reviewAvText: { fontSize: 13, fontWeight: '700', color: C.spice },
  reviewName: { fontSize: 13, fontWeight: '600', color: C.ink },
  reviewDate: { fontSize: 10, color: C.warmGray, marginTop: 1 },
  reviewStars: { flexDirection: 'row', gap: 1 },
  reviewComment: { fontSize: 12, color: C.warmGray, lineHeight: 18, fontStyle: 'italic' },

  // Earnings
  earningsCard: { margin: 18, backgroundColor: C.ink, borderRadius: 18, padding: 20 },
  earningsTitle: { fontSize: 14, fontWeight: '700', color: C.white, marginBottom: 16 },
  earningsRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  earningCol: { flex: 1, alignItems: 'center' },
  earningAmt: { fontSize: 22, fontWeight: '800', color: C.turmeric },
  earningLabel: { fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  earningLine: { width: 1, height: 44, backgroundColor: 'rgba(255,255,255,0.15)' },
  payoutBtn: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  payoutBtnText: { color: C.white, fontSize: 13, fontWeight: '600' },
});

const navStyles = StyleSheet.create({
  nav: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: C.white, borderTopWidth: 1, borderTopColor: C.border, paddingBottom: 12, paddingTop: 10, paddingHorizontal: 8 },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  icon: { fontSize: 22 },
  iconActive: { transform: [{ scale: 1.1 }] },
  label: { fontSize: 9, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4, color: '#C0B8B0' },
  labelActive: { color: C.spice },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(26,18,9,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.white, borderRadius: 24, padding: 24, paddingBottom: 36 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginBottom: 18 },
  title: { fontSize: 17, fontWeight: '700', color: C.ink, marginBottom: 6 },
  sub: { fontSize: 12, color: C.warmGray, marginBottom: 18 },
  limitNote: { fontSize: 11, fontWeight: '700', color: C.spice, marginTop: -6, marginBottom: 14 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, marginBottom: 20 },
  rupee: { fontSize: 18, fontWeight: '700', color: C.warmGray, marginRight: 6 },
  input: { flex: 1, fontSize: 24, fontWeight: '700', color: C.ink, paddingVertical: Platform.OS === 'ios' ? 14 : 10 },
  actions: { flexDirection: 'row', gap: 10 },
  cancelBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, alignItems: 'center' },
  cancelText: { fontSize: 14, fontWeight: '600', color: C.warmGray },
  sendBtn: { flex: 2, paddingVertical: 13, borderRadius: 12, backgroundColor: C.spice, alignItems: 'center', shadowColor: C.spice, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.28, shadowRadius: 8, elevation: 3 },
  sendText: { fontSize: 14, fontWeight: '700', color: C.white },
});

const negSt = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#FDFAF5', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32, maxHeight: '85%',
  },
  handle: { alignSelf: 'center', width: 42, height: 5, borderRadius: 3, backgroundColor: '#D9D3CB', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '900', color: '#1A1209', marginBottom: 4 },
  sub: { fontSize: 13, color: '#8A7F74', marginBottom: 18 },
  offerRow: {
    backgroundColor: '#FFFFFF', borderRadius: 16, padding: 14,
    marginBottom: 14, borderWidth: 1, borderColor: '#EDE8E0',
  },
  offerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  offerEmoji: { fontSize: 28 },
  offerDish: { fontSize: 15, fontWeight: '700', color: '#1A1209' },
  offerMeta: { fontSize: 12, color: '#8A7F74', marginTop: 2 },
  offerPrices: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  offerYours: { fontSize: 14, fontWeight: '700', color: '#8A7F74' },
  arrow: { fontSize: 14, color: '#8A7F74' },
  offerChef: { fontSize: 16, fontWeight: '900', color: '#E85D26' },
  counterNote: { fontSize: 12, color: '#8A7F74', fontStyle: 'italic', marginBottom: 10 },
  respondBtns: { flexDirection: 'row', gap: 10 },
  respondBtn: { flex: 1, borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  respondReject: { backgroundColor: '#FFF5F5', borderWidth: 1, borderColor: '#F5C0C0' },
  respondRejectText: { fontSize: 13, fontWeight: '800', color: '#E53E3E' },
  respondCounter: { backgroundColor: '#FEF9EE', borderWidth: 1, borderColor: '#F4D98B' },
  respondCounterText: { fontSize: 13, fontWeight: '800', color: '#B07800' },
  respondAccept: { backgroundColor: '#E8F5EE', borderWidth: 1, borderColor: '#A8E6CF' },
  respondAcceptText: { fontSize: 13, fontWeight: '800', color: '#1A6B4A' },

  // Buyer counter input modal
  inputOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  inputSheet: { backgroundColor: '#FDFAF5', borderRadius: 24, padding: 24, width: '100%' },
  inputTitle: { fontSize: 20, fontWeight: '900', color: '#1A1209', marginBottom: 4 },
  inputSub: { fontSize: 13, color: '#8A7F74', marginBottom: 18 },
  input: {
    backgroundColor: '#F2F5F0', borderRadius: 12, borderWidth: 1, borderColor: '#EDE8E0',
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: '#1A1209', marginBottom: 6,
  },
  inputBtns: { flexDirection: 'row', gap: 12, marginTop: 16 },
  inputBtn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  inputBtnCancel: { backgroundColor: '#F2F5F0', borderWidth: 1, borderColor: '#EDE8E0' },
  inputBtnCancelText: { fontSize: 14, fontWeight: '700', color: '#8A7F74' },
  inputBtnSend: { backgroundColor: '#E85D26' },
  inputBtnSendText: { fontSize: 14, fontWeight: '800', color: '#FFFFFF' },
  lastCounterBanner: {
    backgroundColor: '#FEF9EE', borderRadius: 12, padding: 12,
    marginBottom: 14, borderLeftWidth: 3, borderLeftColor: '#F4A623',
  },
  lastCounterLabel: { fontSize: 9, fontWeight: '800', color: '#B07800', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },
  lastCounterValue: { fontSize: 20, fontWeight: '900', color: '#1A1209', marginBottom: 2 },
  lastCounterHint: { fontSize: 11, color: '#8A7F74' },
  inputError: { borderColor: '#E53E3E', borderWidth: 1.5 },
  errorText: { fontSize: 11, color: '#E53E3E', marginTop: 4, marginBottom: 2 },
});




