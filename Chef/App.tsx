import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WebView } from 'react-native-webview';
import {
  ActivityIndicator,
  AppState,
  Alert,
  Animated,
  Dimensions,
  Image,
  Linking,
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
import Slider from '@react-native-community/slider';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  API_BASE,
  Auth,
  Cooking,
  MarketPrices,
  Moderation,
  Offers,
  Orders,
  Quotes,
  Requests,
  Tokens,
  Users,
  type CookingDishItem,
  type CreateCookingDishPayload,
  type DishOffer,
  type MarketPriceCatalogItem,
  type ModerationReason,
  type OrderItem,
  type OrderStatus,
  type QuoteItem,
  type RequestItem,
  type SpecialityDish,
  type UserProfile,
} from './src/api';

const SW = Dimensions.get('window').width;
const MARKET_PRICE_DEFAULT_ITEMS = [
  { key: 'fish_rohu', label: 'Rohu', category: 'Fish' },
  { key: 'fish_katla', label: 'Katla', category: 'Fish' },
  { key: 'fish_hilsa', label: 'Hilsa', category: 'Fish' },
  { key: 'fish_prawns', label: 'Prawns', category: 'Fish' },
  { key: 'meat_chicken', label: 'Chicken', category: 'Meat' },
  { key: 'meat_mutton', label: 'Mutton', category: 'Meat' },
  { key: 'veg_potato', label: 'Potato', category: 'Veg' },
  { key: 'veg_onion', label: 'Onion', category: 'Veg' },
  { key: 'veg_tomato', label: 'Tomato', category: 'Veg' },
  { key: 'veg_seasonal', label: 'Seasonal Veg', category: 'Veg' },
] as const;

function getLocalDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
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

// ── Design tokens (mint-forward for chef identity) ────────────────────────
const C = {
  mint: '#2D9B6F',
  mintDark: '#1A6B4A',
  mintLight: '#E8F5EE',
  spice: '#E85D26',
  turmeric: '#F4A623',
  ink: '#1A1209',
  cream: '#FDFAF5',
  white: '#FFFFFF',
  warmGray: '#8A7F74',
  border: '#EDE8E0',
  blush: '#FDE8DC',
  paleGreen: '#E8F5EE',
  paleYellow: '#FEF9EE',
  paleBlue: '#EEF2FF',
  red: '#E53E3E',
  paleRed: '#FFF5F5',
  // home screen palette
  bg: '#F2F5F0',
  accent: '#D4F5E9',
  accentStrong: '#A8E6CF',
  primaryLight: '#4EBD96',
  earningsBg: '#1D6B54',
  shadow: 'rgba(46,139,110,0.15)',
} as const;

// ── Status helpers ────────────────────────────────────────────────────────
const ORDER_STATUS_META: Record<string, { label: string; color: string; bg: string; next?: OrderStatus; nextLabel?: string }> = {
  CONFIRMED:        { label: 'Confirmed',       color: '#4F6CF5', bg: C.paleBlue,   next: 'COOKING',          nextLabel: '👨‍🍳 Start Cooking' },
  COOKING:          { label: 'Cooking',          color: C.turmeric, bg: C.paleYellow, next: 'READY',           nextLabel: '✅ Mark as Ready' },
  READY:            { label: 'Ready',            color: C.mint,   bg: C.paleGreen,  next: 'OUT_FOR_DELIVERY', nextLabel: '🛵 Out for Delivery' },
  OUT_FOR_DELIVERY: { label: 'Out for Delivery', color: C.spice,  bg: C.blush,      next: 'DELIVERED',        nextLabel: '📦 Mark Delivered' },
  DELIVERED:        { label: 'Delivered',        color: C.mint,   bg: C.paleGreen },
  CANCELLED:        { label: 'Cancelled',        color: C.red,    bg: C.paleRed },
};
const MAX_REQUEST_QUOTES_PER_SIDE = 2;

const SPICE_LABEL: Record<string, string> = { mild: '🌿 Mild', medium: '🌶 Medium', extra: '🔥 Extra' };
const DELIVERY_LABEL: Record<string, string> = { pickup: '🚶 Pickup', delivery: '🛵 Delivery', both: 'Both' };

function getPaidOfferOrderStatus(offer: DishOffer): 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' {
  if (offer.orderStatus === 'OUT_FOR_DELIVERY' || offer.orderStatus === 'DELIVERED') return offer.orderStatus;
  return 'CONFIRMED';
}

function getPaidOfferAction(offer: DishOffer): { next: 'OUT_FOR_DELIVERY' | 'DELIVERED'; label: string } | null {
  const status = getPaidOfferOrderStatus(offer);
  if (status === 'DELIVERED') return null;
  if (offer.deliveryMode === 'delivery') {
    return status === 'CONFIRMED'
      ? { next: 'OUT_FOR_DELIVERY', label: '🛵 Dispatched' }
      : { next: 'DELIVERED', label: '📦 Delivered' };
  }
  return { next: 'DELIVERED', label: '✅ Delivered' };
}

const DEFAULT_LOCATION = 'Set your location';
const LOCATION_CHOICES: Array<{ name: string; sub: string }> = [];
const CUISINE_TAGS = [
  'Bengali',
  'North Indian',
  'South Indian',
  'Mughlai',
  'Chinese',
  'Tandoor',
  'Street Food',
  'Desserts',
] as const;
const DISH_PREFERENCE_TAGS = [
  'Spicy',
  'Mild',
  'No Onion',
  'No Garlic',
  'Veg',
  'Non Veg',
  'Jain',
  'High Protein',
] as const;
const DISH_EMOJI_OPTIONS = [
  { label: 'Chicken', emoji: '🍗' },
  { label: 'Mutton', emoji: '🥩' },
  { label: 'Veg', emoji: '🥗' },
  { label: 'Dessert', emoji: '🍰' },
  { label: 'Rice', emoji: '🍚' },
  { label: 'Curry', emoji: '🍛' },
  { label: 'Noodles', emoji: '🍜' },
  { label: 'Snacks', emoji: '🥟' },
] as const;

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
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

function formatReadyTime(totalMinutes: number): string {
  if (totalMinutes <= 0) return 'Ready now';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} hr${hours > 1 ? 's' : ''} ${minutes} mins`;
  if (hours > 0) return `${hours} hr${hours > 1 ? 's' : ''}`;
  return `${minutes} mins`;
}

function getLatestNegotiatedRequestPrice(req: RequestItem): number | null {
  if (!req.quotes?.length) return null;
  const latestQuote = [...req.quotes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
  if (!latestQuote) return null;
  return latestQuote.counterOffer ?? latestQuote.price;
}

function normaliseDishName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildSpecialityDish(dish: CookingDishItem): SpecialityDish | null {
  if (!dish.imageUrl) return null;
  return {
    ratingAverage: 0,
    ratingCount: 0,
    recentReviews: [],
    dishName: dish.dishName.trim(),
    description: dish.notes?.trim() || `${dish.dishName} · ${dish.cuisine}`,
    imageUrl: dish.imageUrl,
    lastSoldPrice: dish.pricePerPlate,
    unitsSold: dish.bookedPlates ?? 0,
    cuisine: dish.cuisine,
    tags: dish.tags,
    notes: dish.notes?.trim() ?? '',
    emoji: dish.emoji,
    portionType: dish.portionType,
    portionValue: dish.portionValue,
    portionUnit: dish.portionUnit,
    readyInMinutes: dish.remainingMinutes > 0 ? dish.remainingMinutes : 0,
  };
}

function normaliseSpecialityDish(item: Partial<SpecialityDish>): SpecialityDish {
  const dishName = item.dishName?.trim() || 'Untitled dish';
  const cuisine = item.cuisine?.trim() || 'Custom';
  return {
    ratingAverage: item.ratingAverage ?? 0,
    ratingCount: item.ratingCount ?? 0,
    recentReviews: Array.isArray(item.recentReviews) ? item.recentReviews : [],
    dishName,
    description: item.description?.trim() || `${dishName} · ${cuisine}`,
    imageUrl: item.imageUrl ?? '',
    lastSoldPrice: item.lastSoldPrice ?? 0,
    unitsSold: item.unitsSold ?? 0,
    cuisine,
    tags: Array.isArray(item.tags) ? item.tags : [],
    notes: item.notes ?? '',
    emoji: item.emoji ?? '🍽',
    portionType: item.portionType === 'pieces' ? 'pieces' : 'quantity',
    portionValue: item.portionValue ?? 100,
    portionUnit: item.portionUnit ?? 'gms',
    readyInMinutes: item.readyInMinutes ?? 30,
  };
}

function getSpecialityDishList(value: unknown): SpecialityDish[] {
  return Array.isArray(value) ? value.map((item) => normaliseSpecialityDish(item as Partial<SpecialityDish>)) : [];
}

function upsertSpecialityDish(
  current: SpecialityDish[] | undefined,
  nextDish: SpecialityDish,
): SpecialityDish[] {
  const nextKey = normaliseDishName(nextDish.dishName);
  const deduped = getSpecialityDishList(current)
    .filter((item) => normaliseDishName(item.dishName) !== nextKey);
  return [normaliseSpecialityDish(nextDish), ...deduped].slice(0, 30);
}

// ── Image compression helper ──────────────────────────────────────────────
// Resizes to max 600px and iterates quality down until base64 fits in 30 KB.
async function compressToTargetKB(uri: string, targetKB: number): Promise<{ uri: string; base64: string }> {
  const MAX_BYTES = targetKB * 1024;
  // Start at quality 0.7, step down by 0.1 until size fits
  for (let q = 0.7; q >= 0.1; q = Math.round((q - 0.1) * 10) / 10) {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 600 } }],
      { compress: q, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    // base64 string length * 0.75 ≈ byte size
    if ((result.base64 ?? '').length * 0.75 <= MAX_BYTES) {
      return { uri: result.uri, base64: result.base64! };
    }
  }
  // Fallback: smallest quality pass result
  const final = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 400 } }],
    { compress: 0.1, format: ImageManipulator.SaveFormat.JPEG, base64: true },
  );
  return { uri: final.uri, base64: final.base64! };
}

// ── Screens type ──────────────────────────────────────────────────────────
type Screen =
  | 'auth'
  | 'home'
  | 'request-detail'
  | 'my-quotes'
  | 'today-menu'
  | 'orders'
  | 'order-detail'
  | 'earnings'
  | 'profile';

type RootTab = 'home' | 'today-menu' | 'profile';

type TodayDish = CookingDishItem;
type PaidDishOffer = DishOffer & { status: 'PAID' };

// ─────────────────────────────────────────────────────────────────────────
//  ROOT APP
// ─────────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen]             = useState<Screen>('auth');
  const [user, setUser]                 = useState<UserProfile | null>(null);
  const [isAvailable, setIsAvailable]   = useState(true);
  const [locationLabel, setLocationLabel] = useState(DEFAULT_LOCATION);
  const [userCoords, setUserCoords]     = useState<{ lat: number; lng: number } | null>(null);
  const [geoRadius, setGeoRadius]       = useState(5);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [showLocationMapModal, setShowLocationMapModal] = useState(false);
  const [locationSearch, setLocationSearch] = useState('');
  const [draftMapCoords, setDraftMapCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [mapModalHtml, setMapModalHtml] = useState<string | null>(null);
  const [draftMapLocationName, setDraftMapLocationName] = useState('Locating...');
  const [draftMapLocationLoading, setDraftMapLocationLoading] = useState(false);
  const [locationAddress, setLocationAddress] = useState('');
  const [locationLandmark, setLocationLandmark] = useState('');
  const [buildingImageUri, setBuildingImageUri] = useState<string | null>(null);
  const [buildingImageUrl, setBuildingImageUrl] = useState<string | null>(null);
  const [buildingImageBusy, setBuildingImageBusy] = useState(false);
  const [locating, setLocating]         = useState(false);
  const mapWebViewRef = useRef<WebView>(null);
  const mapLookupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapLookupSeqRef = useRef(0);
  const homeLoadSeqRef = useRef(0);

  // selected item IDs for detail screens
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId]     = useState<string | null>(null);

  // data
  const [requests, setRequests]   = useState<RequestItem[]>([]);
  const [ignoredRequestIds, setIgnoredRequestIds] = useState<string[]>([]);
  const [orders, setOrdersState]  = useState<OrderItem[]>([]);
  const [todayMenu, setTodayMenu] = useState<TodayDish[]>([]);
  const [dishOffers, setDishOffers] = useState<DishOffer[]>([]);
  const [loading, setLoading]     = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showMarketPricePrompt, setShowMarketPricePrompt] = useState(false);
  const [marketPriceBusy, setMarketPriceBusy] = useState(false);
  const [marketPriceCity, setMarketPriceCity] = useState('');
  const [marketPriceCatalog, setMarketPriceCatalog] = useState<MarketPriceCatalogItem[]>([]);
  const [marketPriceValues, setMarketPriceValues] = useState<Record<string, string>>({});
  const marketPricePromptSessionRef = useRef<string | null>(null);
  const pushTokenRef = useRef<string | null>(null);
  const pushRegisteredUserIdRef = useRef<string | null>(null);
  const notificationReceivedSubRef = useRef<{ remove: () => void } | null>(null);
  const notificationResponseSubRef = useRef<{ remove: () => void } | null>(null);

  const syncLocationFromUser = useCallback((profile: UserProfile | null) => {
    if (!profile) {
      setLocationLabel(DEFAULT_LOCATION);
      setLocationAddress('');
      setUserCoords(null);
      return;
    }
    setLocationLabel(profile.location ?? profile.city ?? DEFAULT_LOCATION);
    setLocationAddress(profile.location ?? profile.city ?? '');
    if (typeof profile.lat === 'number' && typeof profile.lng === 'number') {
      setUserCoords({ lat: profile.lat, lng: profile.lng });
    } else {
      setUserCoords(null);
    }
    setIsAvailable(profile.isActive);
  }, []);

  const registerPushToken = useCallback(async (profile: UserProfile) => {
    if (Platform.OS === 'web') return;
    if (pushRegisteredUserIdRef.current === profile.id && pushTokenRef.current) return;
    try {
      const existing = await Notifications.getPermissionsAsync();
      let status = existing.status;
      if (status !== 'granted') {
        const requested = await Notifications.requestPermissionsAsync();
        status = requested.status;
      }
      if (status !== 'granted') return;
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'default',
          importance: Notifications.AndroidImportance.MAX,
        });
      }
      const devicePushToken = await Notifications.getDevicePushTokenAsync();
      const token = typeof devicePushToken.data === 'string' ? devicePushToken.data : null;
      if (!token) return;
      await Users.saveFcmToken(token);
      pushTokenRef.current = token;
      pushRegisteredUserIdRef.current = profile.id;
    } catch {
      // ignore push registration failures
    }
  }, []);

  const unregisterPushToken = useCallback(async () => {
    const token = pushTokenRef.current;
    pushTokenRef.current = null;
    pushRegisteredUserIdRef.current = null;
    if (!token) return;
    try {
      await Users.deleteFcmToken(token);
    } catch {
      // ignore token cleanup failures
    }
  }, []);

  const maybeShowMarketPricePrompt = useCallback(async (profile: UserProfile) => {
    const sessionKey = `${profile.id}:${getLocalDateKey()}`;
    if (marketPricePromptSessionRef.current === sessionKey) return;

    try {
      const [catalog, mineToday] = await Promise.all([
        MarketPrices.catalog(),
        MarketPrices.mineToday(),
      ]);
      const seededValues: Record<string, string> = {};
      mineToday.entries.forEach((entry) => {
        seededValues[entry.itemKey] = String(Math.round(entry.price));
      });
      setMarketPriceCatalog(catalog);
      setMarketPriceValues(seededValues);
      setMarketPriceCity(mineToday.city || profile.city || profile.location || '');
      if (mineToday.entries.length > 0) {
        marketPricePromptSessionRef.current = sessionKey;
        setShowMarketPricePrompt(false);
        return;
      }
    } catch {
      setMarketPriceCatalog(MARKET_PRICE_DEFAULT_ITEMS.map((item) => ({
        key: item.key,
        label: item.label,
        category: item.category.toLowerCase(),
        unit: 'kg',
      })));
      setMarketPriceValues({});
      setMarketPriceCity(profile.city || profile.location || '');
    }

    marketPricePromptSessionRef.current = sessionKey;
    setShowMarketPricePrompt(true);
  }, []);

  const dismissMarketPricePrompt = useCallback(async () => {
    setShowMarketPricePrompt(false);
  }, []);

  // ── Boot: check stored token ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const token = await Tokens.getAccess();
      if (token) {
        try {
          const me = await Users.me();
          setUser(me);
          syncLocationFromUser(me);
          await registerPushToken(me);
          await maybeShowMarketPricePrompt(me);
          setScreen('home');
          await loadHomeData(
            typeof me.lat === 'number' && typeof me.lng === 'number' ? { lat: me.lat, lng: me.lng } : null,
          );
          await loadTodayMenu();
        } catch {
          await unregisterPushToken();
          await Tokens.clear();
        }
      }
    })();
  }, [maybeShowMarketPricePrompt, registerPushToken, syncLocationFromUser, unregisterPushToken]);

  // ── Periodic poll for new requests (every 30s on home) ────────────────
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
          headers: { Accept: 'application/json', 'Accept-Language': 'en' },
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

  async function loadRequestBoardData(coordsOverride?: { lat: number; lng: number } | null) {
    const coords = coordsOverride === undefined ? userCoords : coordsOverride;
    return Requests.nearby(coords ? { ...coords } : {});
  }

  async function refreshRequestBoard(coordsOverride?: { lat: number; lng: number } | null) {
    const seq = ++homeLoadSeqRef.current;
    try {
      const nextRequests = await loadRequestBoardData(coordsOverride);
      if (seq !== homeLoadSeqRef.current) return;
      setRequests(nextRequests);
    } catch {
      // keep the last visible request board state on transient failures
    }
  }

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (screen === 'home') {
      pollRef.current = setInterval(() => {
        refreshRequestBoard().catch(() => undefined);
      }, 4000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [geoRadius, screen, userCoords]);

  const homePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (screen === 'home') {
      homePollRef.current = setInterval(() => {
        loadHomeData().catch(() => undefined);
      }, 12000);
    }
    return () => { if (homePollRef.current) clearInterval(homePollRef.current); };
  }, [geoRadius, screen, userCoords]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && screen === 'home' && user) {
        refreshRequestBoard().catch(() => undefined);
      }
    });
    return () => sub.remove();
  }, [screen, user, geoRadius, userCoords]);

  async function loadHomeData(coordsOverride?: { lat: number; lng: number } | null) {
    try {
      const seq = ++homeLoadSeqRef.current;
      const [reqs, ords, offrs] = await Promise.allSettled([
        loadRequestBoardData(coordsOverride),
        Orders.list(),
        Offers.list(['PENDING', 'COUNTERED', 'HOLD', 'PAID']),
      ]);
      if (seq !== homeLoadSeqRef.current) return;
      if (reqs.status === 'fulfilled') {
        setRequests(reqs.value);
      }
      if (ords.status === 'fulfilled') {
        setOrdersState(ords.value.filter((o) => !['DELIVERED', 'CANCELLED'].includes(o.status)));
      }
      if (offrs.status === 'fulfilled') {
        setDishOffers(offrs.value);
      }
    } catch { /* silently ignore on background poll */ }
  }

  async function loadTodayMenu() {
    try {
      setTodayMenu(await Cooking.mine());
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!user) return;
    const currentSpecialities = getSpecialityDishList(user.specialityDishes);
    const nextSpecialities = todayMenu.reduce<SpecialityDish[]>((acc, dish) => {
      const speciality = buildSpecialityDish(dish);
      return speciality ? upsertSpecialityDish(acc, speciality) : acc;
    }, currentSpecialities);

    const same =
      nextSpecialities.length === currentSpecialities.length &&
      nextSpecialities.every((item, idx) => {
        const current = currentSpecialities[idx] ?? null;
        return current &&
          current.dishName === item.dishName &&
          current.description === item.description &&
          current.imageUrl === item.imageUrl &&
          current.lastSoldPrice === item.lastSoldPrice &&
          current.unitsSold === item.unitsSold &&
          current.cuisine === item.cuisine &&
          current.notes === item.notes &&
          current.emoji === item.emoji &&
          current.portionType === item.portionType &&
          current.portionValue === item.portionValue &&
          current.portionUnit === item.portionUnit &&
          current.readyInMinutes === item.readyInMinutes &&
          current.tags.join('|') === item.tags.join('|');
      });

    if (!same) {
      Moderation.acceptPolicy()
        .catch(() => undefined)
        .then(() => Users.updateMe({ specialityDishes: nextSpecialities }))
        .then((updatedUser) => setUser(updatedUser))
        .catch(() => undefined);
    }
  }, [todayMenu, user]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([refreshRequestBoard(), loadHomeData()]);
    setRefreshing(false);
  }, [loadHomeData]);

  useEffect(() => {
    if (screen === 'home' && user) {
      refreshRequestBoard().catch(() => undefined);
      loadHomeData().catch(() => undefined);
    }
  }, [geoRadius, screen, user, userCoords]);

  useEffect(() => {
    notificationReceivedSubRef.current?.remove();
    notificationResponseSubRef.current?.remove();
    if (!user) return;

    const maybeRefreshRequests = (data?: Record<string, unknown>) => {
      if (data?.type === 'NEW_REQUEST') {
        refreshRequestBoard().catch(() => undefined);
      }
    };

    notificationReceivedSubRef.current = Notifications.addNotificationReceivedListener((event) => {
      maybeRefreshRequests(event.request.content.data as Record<string, unknown> | undefined);
    });
    notificationResponseSubRef.current = Notifications.addNotificationResponseReceivedListener((response) => {
      maybeRefreshRequests(response.notification.request.content.data as Record<string, unknown> | undefined);
      setScreen('home');
    });

    return () => {
      notificationReceivedSubRef.current?.remove();
      notificationResponseSubRef.current?.remove();
      notificationReceivedSubRef.current = null;
      notificationResponseSubRef.current = null;
    };
  }, [user, loadHomeData]);

  const handleLogin = async (me: UserProfile) => {
    setUser(me);
    syncLocationFromUser(me);
    setScreen('home');
    setLoading(true);

    const coords = typeof me.lat === 'number' && typeof me.lng === 'number'
      ? { lat: me.lat, lng: me.lng }
      : null;

    const results = await Promise.allSettled([
      registerPushToken(me),
      maybeShowMarketPricePrompt(me),
      loadHomeData(coords),
      loadTodayMenu(),
    ]);

    setLoading(false);

    const failedCriticalLoad = results[2]?.status === 'rejected' && results[3]?.status === 'rejected';
    if (failedCriticalLoad) {
      throw new Error('Login succeeded, but the app could not load chef data from the server.');
    }
  };

  const handleLogout = async () => {
    const refresh = await Tokens.getRefresh();
    await unregisterPushToken();
    await Auth.logout(refresh ?? '');
    setUser(null);
    syncLocationFromUser(null);
    setRequests([]);
    setOrdersState([]);
    setTodayMenu([]);
    setDishOffers([]);
    setScreen('auth');
  };

  const submitDailyMarketPrices = useCallback(async () => {
    if (!user) return;
    setMarketPriceBusy(true);
    try {
      const entries = Object.entries(marketPriceValues).map(([itemKey, value]) => {
        const digits = value.replace(/[^0-9.]/g, '');
        return {
          itemKey,
          price: digits ? Number(digits) : null,
        };
      });
      await MarketPrices.submitDaily({
        city: marketPriceCity.trim() || user.city || user.location || undefined,
        entries,
      });
      await dismissMarketPricePrompt();
      Alert.alert('Saved', 'Today’s market prices have been noted.');
    } catch (error) {
      Alert.alert('Could not save', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setMarketPriceBusy(false);
    }
  }, [dismissMarketPricePrompt, marketPriceCity, marketPriceValues, user]);

  const goRequestDetail = (id: string) => { setActiveRequestId(id); setScreen('request-detail'); };
  const goOrderDetail   = (id: string) => { setActiveOrderId(id);   setScreen('order-detail'); };

  const toggleAvailability = async (val: boolean) => {
    setIsAvailable(val);
    try { await Users.updateMe({ isActive: val }); } catch { setIsAvailable(!val); }
  };

  const applySelectedCoords = useCallback(async (latitude: number, longitude: number) => {
    const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
    const parts = [place?.city || place?.district || place?.subregion, place?.region].filter(Boolean);
    const addressParts = [
      place?.name,
      place?.street,
      place?.district,
      place?.city || place?.subregion,
      place?.region,
      place?.postalCode,
      place?.country,
    ].filter(Boolean);
    const nextLocation = parts.join(', ') || addressParts.join(', ') || DEFAULT_LOCATION;
    const coords = { lat: latitude, lng: longitude };

    setLocationLabel(nextLocation);
    setLocationSearch(nextLocation);
    setLocationAddress(addressParts.join(', ') || nextLocation);
    setLocationLandmark(place?.name && place?.street && place.name !== place.street ? place.name : '');
    setUserCoords(coords);
  }, [geoRadius, user]);

  const useCurrentLocation = useCallback(async () => {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission denied', 'Allow location access to auto-detect your area.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const latitude = pos.coords.latitude;
      const longitude = pos.coords.longitude;
      setDraftMapCoords({ lat: latitude, lng: longitude });
      setMapModalHtml(getLocationMapHtml(latitude, longitude, geoRadius));
      setDraftMapLocationName('Locating...');
      setShowLocationMapModal(true);
    } catch {
      Alert.alert('Error', 'Could not fetch your location. Try again.');
    } finally {
      setLocating(false);
    }
  }, [geoRadius]);

  const confirmMapLocation = useCallback(async () => {
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
  }, [applySelectedCoords, draftMapCoords]);

  const pickBuildingImage = useCallback(async () => {
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
        quality: 0.8,
      });
      if (result.canceled) return;
      const compressed = await compressToTargetKB(result.assets[0].uri, 30);
      const imageData = `data:image/jpeg;base64,${compressed.base64}`;
      const { url } = await Users.uploadKitchenImage(imageData);
      setBuildingImageUri(compressed.uri);
      setBuildingImageUrl(url);
    } catch {
      Alert.alert('Upload failed', 'Could not upload the building image. Try again.');
    } finally {
      setBuildingImageBusy(false);
    }
  }, []);

  const saveChefLocationDetails = useCallback(async () => {
    const nextLocation = locationLabel.trim();
    if (!nextLocation || nextLocation === DEFAULT_LOCATION) {
      Alert.alert('Choose a location', 'Pick a location from the map or search first.');
      return;
    }
    setLocating(true);
    try {
      if (user) {
        const locationSummary = [
          locationAddress.trim() || nextLocation,
          locationLandmark.trim() ? `Landmark: ${locationLandmark.trim()}` : '',
          buildingImageUrl ? `Building image: ${buildingImageUrl}` : '',
        ].filter(Boolean).join('\n');
        const updated = await Users.updateMe({
          city: nextLocation,
          location: locationSummary || nextLocation,
          lat: userCoords?.lat ?? null,
          lng: userCoords?.lng ?? null,
        });
        setUser(updated);
      }
      await loadHomeData(userCoords);
      setShowLocationModal(false);
    } catch {
      Alert.alert('Save failed', 'Could not save location details. Try again.');
    } finally {
      setLocating(false);
    }
  }, [buildingImageUrl, geoRadius, locationAddress, locationLabel, locationLandmark, user, userCoords]);

  const saveChefAddress = useCallback(async () => {
    const address = locationAddress.trim() || locationLabel.trim();
    if (!address || address === DEFAULT_LOCATION) {
      Alert.alert('Add address', 'Pick a location and confirm the address first.');
      return;
    }
    setLocating(true);
    try {
      await Users.saveAddress({
        label: 'Kitchen',
        address: [
          address,
          locationLandmark.trim() ? `Landmark: ${locationLandmark.trim()}` : '',
          buildingImageUrl ? `Building image: ${buildingImageUrl}` : '',
        ].filter(Boolean).join('\n'),
        lat: userCoords?.lat,
        lng: userCoords?.lng,
      });
      Alert.alert('Address saved', 'This kitchen address is now saved to your account.');
    } catch {
      Alert.alert('Save failed', 'Could not save this address. Try again.');
    } finally {
      setLocating(false);
    }
  }, [buildingImageUrl, locationAddress, locationLabel, locationLandmark, userCoords]);

  const setManualLocation = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setLocationLabel(trimmed);
    setUserCoords(null);
    setLocationAddress(trimmed);
    if (user) {
      try {
        const updated = await Users.updateMe({ city: trimmed, location: trimmed, lat: null, lng: null });
        setUser(updated);
      } catch { /* ignore */ }
    }
    await loadHomeData(null);
  }, [geoRadius, user]);

  // ── Active & past orders ─────────────────────────────────────────────
  const activeOrders = orders.filter((o) => !['DELIVERED', 'CANCELLED'].includes(o.status));
  const acceptedDishOffers = dishOffers.filter((offer): offer is PaidDishOffer => offer.status === 'PAID');
  const totalPaidOfferEarnings = acceptedDishOffers.reduce((sum, offer) => sum + ((offer.agreedPrice ?? offer.offerPrice) * offer.plates), 0);
  const showRootNav = screen === 'home' || screen === 'today-menu' || screen === 'profile';
  const activeRootTab: RootTab = screen === 'today-menu' || screen === 'profile' ? screen : 'home';

  return (
    <SafeAreaView style={ss.safe} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />

      {/* ── AUTH ─────────────────────────────────────────────────────── */}
      {screen === 'auth' ? <AuthScreen onSuccess={handleLogin} /> : null}

      {/* ── HOME ─────────────────────────────────────────────────────── */}
      {screen === 'home' ? (
        <HomeScreen
          user={user}
          isAvailable={isAvailable}
          locationLabel={locationLabel}
          geoRadius={geoRadius}
          hasGpsLocation={!!userCoords}
          todayMenu={todayMenu}
          onOpenSkills={() => setScreen('today-menu')}
          onOpenLocationSettings={() => { setLocationSearch(''); setShowLocationModal(true); }}
          onToggleAvailability={toggleAvailability}
          requests={requests}
          ignoredRequestIds={ignoredRequestIds}
          onIgnoreRequest={(id) => setIgnoredRequestIds((prev) => [...prev, id])}
          chefGeoRadius={geoRadius}
          activeOrders={activeOrders}
          dishOffers={dishOffers}
          acceptedDishOffers={acceptedDishOffers}
          earningsTotal={totalPaidOfferEarnings}
          loading={loading}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onRequestPress={goRequestDetail}
          onOrderPress={goOrderDetail}
          onViewAllOrders={() => setScreen('orders')}
          onViewEarnings={() => setScreen('earnings')}
          onViewProfile={() => setScreen('profile')}
          onOfferAccept={async (id) => {
            const updated = await Offers.accept(id);
            setDishOffers((prev) => prev.map((o) => o.id === id ? updated : o));
          }}
          onOfferReject={async (id) => {
            const updated = await Offers.reject(id);
            setDishOffers((prev) => prev.map((o) => o.id === id ? updated : o));
          }}
          onOfferCounter={async (id, counterPrice, counterNote) => {
            const updated = await Offers.counter(id, counterPrice, counterNote);
            setDishOffers((prev) => prev.map((o) => o.id === id ? updated : o));
          }}
        />
      ) : null}

      {/* ── REQUEST DETAIL ───────────────────────────────────────────── */}
      {screen === 'request-detail' && activeRequestId ? (
        <RequestDetailScreen
          requestId={activeRequestId}
          chefId={user?.id ?? ''}
          cookingStyle={user?.cookingStyle}
          onBack={() => setScreen('home')}
          onQuoteSubmitted={() => setScreen('home')}
        />
      ) : null}

      {/* ── ALL ORDERS ───────────────────────────────────────────────── */}
      {screen === 'orders' ? (
        <OrdersScreen
          onBack={() => setScreen('home')}
          onOrderPress={goOrderDetail}
        />
      ) : null}

      {screen === 'today-menu' ? (
        <TodayMenuScreen
          dishes={todayMenu}
          specialityDishes={getSpecialityDishList(user?.specialityDishes)}
          onBack={() => setScreen('home')}
          onSaveDish={async (dish) => {
            const saved = await Cooking.create(dish);
            setTodayMenu((curr) => [saved, ...curr.filter((item) => item.id !== saved.id)].slice(0, 8));
            if (user) {
              const specialityDish = buildSpecialityDish(saved);
              if (specialityDish) {
                const updatedUser = await Users.updateMe({
                  specialityDishes: upsertSpecialityDish(getSpecialityDishList(user.specialityDishes), specialityDish),
                });
                setUser(updatedUser);
              }
            }
          }}
          onRemoveDish={async (id) => {
            await Cooking.remove(id);
            setTodayMenu((curr) => curr.filter((item) => item.id !== id));
          }}
          onExtendTimer={async (id, minutes) => {
            const updated = await Cooking.update(id, { extensionMinutes: minutes });
            setTodayMenu((curr) => curr.map((d) => d.id === id ? updated : d));
          }}
          onGoLive={async (id, base64) => {
            const imageUrl = `data:image/jpeg;base64,${base64}`;
            const updated = await Cooking.update(id, { imageUrl });
            setTodayMenu((curr) => curr.map((d) => d.id === id ? updated : d));
            if (user) {
              const specialityDish = buildSpecialityDish(updated);
              if (specialityDish) {
                const updatedUser = await Users.updateMe({
                  specialityDishes: upsertSpecialityDish(getSpecialityDishList(user.specialityDishes), specialityDish),
                });
                setUser(updatedUser);
              }
            }
          }}
        />
      ) : null}

      {/* ── ORDER DETAIL ─────────────────────────────────────────────── */}
      {screen === 'order-detail' && activeOrderId ? (
        <OrderDetailScreen
          orderId={activeOrderId}
          onBack={() => { setScreen('orders'); loadHomeData(); }}
        />
      ) : null}

      {/* ── EARNINGS ─────────────────────────────────────────────────── */}
      {screen === 'earnings' ? (
        <EarningsScreen
          user={user}
          paidOffers={acceptedDishOffers}
          onBack={() => setScreen('home')}
        />
      ) : null}

      {/* ── PROFILE ──────────────────────────────────────────────────── */}
      {screen === 'profile' ? (
        <ProfileScreen
          user={user}
          isAvailable={isAvailable}
          locationLabel={locationLabel}
          hasGpsLocation={!!userCoords}
          geoRadius={geoRadius}
          onOpenLocationSettings={() => { setLocationSearch(''); setShowLocationModal(true); }}
          onToggleAvailability={toggleAvailability}
          onOpenTodayBoard={() => setScreen('today-menu')}
          onBack={() => setScreen('home')}
          onLogout={handleLogout}
          onSaved={(updated) => { setUser(updated); syncLocationFromUser(updated); }}
        />
      ) : null}

      {showRootNav ? (
        <ChefBottomNav
          active={activeRootTab}
          onHomePress={() => setScreen('home')}
          onTodayBoardPress={() => setScreen('today-menu')}
          onProfilePress={() => setScreen('profile')}
        />
      ) : null}

      <MarketPricePromptModal
        visible={showMarketPricePrompt}
        city={marketPriceCity}
        onCityChange={setMarketPriceCity}
        catalog={marketPriceCatalog.length ? marketPriceCatalog : MARKET_PRICE_DEFAULT_ITEMS.map((item) => ({
          key: item.key,
          label: item.label,
          category: item.category.toLowerCase(),
          unit: 'kg',
        }))}
        values={marketPriceValues}
        busy={marketPriceBusy}
        onChangeValue={(itemKey, nextValue) => {
          setMarketPriceValues((current) => ({ ...current, [itemKey]: nextValue.replace(/[^0-9.]/g, '') }));
        }}
        onSkip={() => dismissMarketPricePrompt()}
        onSubmit={submitDailyMarketPrices}
      />

      <Modal visible={showLocationModal} animationType="slide" transparent onRequestClose={() => setShowLocationModal(false)}>
        <TouchableOpacity style={locSt.backdrop} activeOpacity={1} onPress={() => setShowLocationModal(false)} />
        <View style={locSt.sheet}>
          <ScrollView style={locSt.sheetScroll} contentContainerStyle={locSt.sheetContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={locSt.handle} />
          <Text style={locSt.title}>Chef delivery area</Text>
          <Text style={locSt.sub}>Set your base location and how far away requests should appear.</Text>

          <View style={locSt.searchRow}>
            <TextInput
              style={locSt.searchInput}
              value={locationSearch}
              onChangeText={setLocationSearch}
              placeholder="Search city or area"
              placeholderTextColor="#BDB5AB"
            />
            {locationSearch.length > 0 ? (
              <TouchableOpacity onPress={() => setLocationSearch('')}>
                <Text style={locSt.clearBtn}>✕</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <TouchableOpacity style={locSt.gpsBtn} activeOpacity={0.8} onPress={useCurrentLocation} disabled={locating}>
            <View>
              <Text style={locSt.gpsBtnText}>{locating ? 'Detecting location…' : 'Use my current location'}</Text>
              <Text style={locSt.gpsBtnSub}>Auto-detect via GPS, open the map, and fine-tune your exact service point</Text>
            </View>
            <Text style={locSt.gpsBtnIcon}>🎯</Text>
          </TouchableOpacity>

          <View style={locSt.radiusBox}>
            <View style={locSt.radiusRow}>
              <Text style={locSt.radiusLabel}>Geo-fencing range</Text>
              <Text style={locSt.radiusValue}>{geoRadius} km</Text>
            </View>
            <Slider
              style={locSt.slider}
              minimumValue={1}
              maximumValue={20}
              step={1}
              minimumTrackTintColor={C.mint}
              maximumTrackTintColor={C.border}
              thumbTintColor={C.mint}
              value={geoRadius}
              onValueChange={setGeoRadius}
            />
            <View style={locSt.radiusTicks}>
              <Text style={locSt.radiusTick}>1 km</Text>
              <Text style={locSt.radiusTick}>5 km</Text>
              <Text style={locSt.radiusTick}>10 km</Text>
              <Text style={locSt.radiusTick}>20 km</Text>
            </View>
            {!userCoords ? <Text style={locSt.radiusHint}>Use GPS above to enable strict geo-fencing around your current location.</Text> : null}
          </View>

          {userCoords ? (
            <View style={locSt.mapCard}>
              <View style={locSt.mapCaption}>
                <Text style={locSt.mapCaptionTitle}>Selected location</Text>
                <Text style={locSt.mapCaptionSub}>{locationLabel}</Text>
              </View>
            </View>
          ) : null}

          <View style={locSt.addressCard}>
            <Text style={locSt.addressTitle}>Address details</Text>
            <TextInput
              style={[locSt.fieldInput, locSt.fieldInputMultiline]}
              value={locationAddress}
              onChangeText={setLocationAddress}
              placeholder="Full address, apartment, street, locality, pincode"
              placeholderTextColor="#BDB5AB"
              multiline
            />
            <TextInput
              style={locSt.fieldInput}
              value={locationLandmark}
              onChangeText={setLocationLandmark}
              placeholder="Landmark (optional)"
              placeholderTextColor="#BDB5AB"
            />
            <TouchableOpacity style={locSt.photoBtn} activeOpacity={0.8} onPress={pickBuildingImage} disabled={buildingImageBusy}>
              {buildingImageUri ? (
                <Image source={{ uri: buildingImageUri }} style={locSt.photoPreview} resizeMode="cover" />
              ) : (
                <View style={locSt.photoPlaceholder}>
                  <Text style={locSt.photoPlaceholderText}>IMG</Text>
                </View>
              )}
              <View style={locSt.photoCopy}>
                <Text style={locSt.photoTitle}>{buildingImageBusy ? 'Uploading building image...' : 'Upload building image'}</Text>
                <Text style={locSt.photoSub}>{buildingImageUrl ? 'Building image saved.' : 'Optional. Helps buyers and delivery staff identify your place.'}</Text>
              </View>
            </TouchableOpacity>
          </View>

          <View style={locSt.saveActions}>
            <TouchableOpacity style={locSt.saveSecondaryBtn} activeOpacity={0.85} onPress={saveChefAddress}>
              <Text style={locSt.saveSecondaryBtnText}>Save address</Text>
            </TouchableOpacity>
            <TouchableOpacity style={locSt.saveBtn} activeOpacity={0.85} onPress={saveChefLocationDetails}>
              <Text style={locSt.saveBtnText}>{locating ? 'Saving...' : 'Save location details'}</Text>
            </TouchableOpacity>
          </View>

          <View style={locSt.results}>
            {locationSearch.trim().length > 0 ? (
              <TouchableOpacity style={locSt.listItem} activeOpacity={0.75} onPress={() => setManualLocation(locationSearch)}>
                <Text style={locSt.listItemIcon}>📍</Text>
                <View>
                  <Text style={locSt.listItemName}>{locationSearch.trim()}</Text>
                  <Text style={locSt.listItemSub}>Use this location</Text>
                </View>
              </TouchableOpacity>
            ) : null}

            {LOCATION_CHOICES
              .filter((city) => city.name.toLowerCase().includes(locationSearch.toLowerCase()))
              .map((city) => (
                <TouchableOpacity
                  key={city.name}
                  style={[locSt.listItem, locationLabel === city.name && locSt.listItemActive]}
                  activeOpacity={0.75}
                  onPress={() => setManualLocation(city.name)}
                >
                  <Text style={locSt.listItemIcon}>{locationLabel === city.name ? '✅' : '📍'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[locSt.listItemName, locationLabel === city.name && locSt.listItemNameActive]}>{city.name}</Text>
                    <Text style={locSt.listItemSub}>{city.sub}</Text>
                  </View>
                </TouchableOpacity>
              ))}
          </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={showLocationMapModal} animationType="slide" transparent onRequestClose={() => setShowLocationMapModal(false)}>
        <View style={locSt.mapPopupBackdrop}>
          <View style={locSt.mapPopupSheet}>
            <View style={locSt.handle} />
            <Text style={locSt.title}>Pick exact location</Text>
            <Text style={locSt.sub}>Keep the pin fixed and move the map until the center matches your kitchen location.</Text>
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
                  <View style={locSt.fixedPinDot} />
                  <View style={locSt.fixedPinStem} />
                  <View style={locSt.fixedPinTip} />
                </View>
              </View>
            ) : null}
            <View style={locSt.mapRadiusRow}>
              <Text style={locSt.radiusLabel}>Geo-fencing range</Text>
              <View style={locSt.mapRadiusControls}>
                <TouchableOpacity style={locSt.mapRadiusBtn} activeOpacity={0.8} onPress={() => setGeoRadius((current) => Math.max(1, current - 1))}>
                  <Text style={locSt.mapRadiusBtnText}>-</Text>
                </TouchableOpacity>
                <View style={locSt.mapRadiusValuePill}>
                  <Text style={locSt.mapRadiusValueText}>{geoRadius} km</Text>
                </View>
                <TouchableOpacity style={locSt.mapRadiusBtn} activeOpacity={0.8} onPress={() => setGeoRadius((current) => Math.min(20, current + 1))}>
                  <Text style={locSt.mapRadiusBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
            <View style={locSt.mapCoordsRow}>
              <Text style={locSt.mapCoordsLabel}>Selected location</Text>
              <Text style={locSt.mapCoordsValue}>{draftMapLocationLoading ? 'Looking up place...' : draftMapLocationName}</Text>
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
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  AUTH SCREEN
// ─────────────────────────────────────────────────────────────────────────
function ChefBottomNav({
  active,
  onHomePress,
  onTodayBoardPress,
  onProfilePress,
}: {
  active: RootTab;
  onHomePress: () => void;
  onTodayBoardPress: () => void;
  onProfilePress: () => void;
}) {
  const items: Array<{ key: RootTab; label: string; icon: string; onPress: () => void }> = [
    { key: 'home', label: 'Home', icon: '🏠', onPress: onHomePress },
    { key: 'today-menu', label: 'Today Board', icon: '🍽', onPress: onTodayBoardPress },
    { key: 'profile', label: 'Profile', icon: '👤', onPress: onProfilePress },
  ];

  return (
    <View style={navSt.nav}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <TouchableOpacity key={item.key} style={navSt.tab} activeOpacity={0.7} onPress={item.onPress}>
            {isActive && <View style={navSt.activeIndicator} />}
            <Text style={[navSt.icon, isActive && navSt.iconActive]}>{item.icon}</Text>
            <Text style={[navSt.label, isActive && navSt.labelActive]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function MarketPricePromptModal({
  visible,
  city,
  onCityChange,
  catalog,
  values,
  busy,
  onChangeValue,
  onSkip,
  onSubmit,
}: {
  visible: boolean;
  city: string;
  onCityChange: (value: string) => void;
  catalog: MarketPriceCatalogItem[];
  values: Record<string, string>;
  busy: boolean;
  onChangeValue: (itemKey: string, value: string) => void;
  onSkip: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onSkip}>
      <View style={mpSt.backdrop}>
        <View style={mpSt.card}>
          <Text style={mpSt.title}>Today&apos;s market check</Text>
          <Text style={mpSt.sub}>Optional. Add any raw market prices you know from this morning so buyer budget suggestions stay closer to your city.</Text>

          <Text style={mpSt.label}>City</Text>
          <TextInput
            style={mpSt.cityInput}
            value={city}
            onChangeText={onCityChange}
            placeholder="Kolkata"
            placeholderTextColor="#BDB5AB"
          />

          <ScrollView style={mpSt.list} contentContainerStyle={mpSt.listContent} showsVerticalScrollIndicator={false}>
            {catalog.map((item) => (
              <View key={item.key} style={mpSt.row}>
                <View style={mpSt.rowCopy}>
                  <Text style={mpSt.rowTitle}>{item.label}</Text>
                  <Text style={mpSt.rowMeta}>{item.category} · per {item.unit}</Text>
                </View>
                <View style={mpSt.priceBox}>
                  <Text style={mpSt.currency}>₹</Text>
                  <TextInput
                    style={mpSt.priceInput}
                    value={values[item.key] ?? ''}
                    onChangeText={(next) => onChangeValue(item.key, next)}
                    keyboardType="number-pad"
                    placeholder="Optional"
                    placeholderTextColor="#BDB5AB"
                  />
                </View>
              </View>
            ))}
          </ScrollView>

          <View style={mpSt.actions}>
            <TouchableOpacity style={mpSt.skipBtn} activeOpacity={0.85} onPress={onSkip} disabled={busy}>
              <Text style={mpSt.skipText}>Skip today</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[mpSt.saveBtn, busy && { opacity: 0.7 }]} activeOpacity={0.85} onPress={onSubmit} disabled={busy}>
              {busy ? <ActivityIndicator color={C.white} /> : <Text style={mpSt.saveText}>Save prices</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function AuthScreen({ onSuccess }: { onSuccess: (user: UserProfile) => Promise<void> | void }) {
  const [mode, setMode]         = useState<'login' | 'register'>('login');
  const [name, setName]         = useState('');
  const [phone, setPhone]       = useState('');
  const [password, setPassword] = useState('');
  const [city, setCity]         = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const submit = async () => {
    setError('');
    if (!phone || !password || (mode === 'register' && !name)) {
      setError('Please fill all required fields.');
      return;
    }
    setLoading(true);
    try {
      const res = mode === 'login'
        ? await Auth.login(phone, password)
        : await Auth.register({ name, phone, password, city });
      await Tokens.set(res.accessToken, res.refreshToken);
      await onSuccess(res.user);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={authSt.scroll} keyboardShouldPersistTaps="handled">
      {/* Brand */}
      <View style={authSt.brandWrap}>
        <View style={authSt.brandIcon}>
          <Text style={authSt.brandEmoji}>👨‍🍳</Text>
        </View>
        <Text style={authSt.brandTitle}>NeighbourBites</Text>
        <Text style={authSt.brandSub}>Chef Partner App</Text>
      </View>

      {/* Tab toggle */}
      <View style={authSt.tabs}>
        <TouchableOpacity
          style={[authSt.tab, mode === 'login' && authSt.tabActive]}
          onPress={() => { setMode('login'); setError(''); }}
          activeOpacity={0.8}
        >
          <Text style={[authSt.tabText, mode === 'login' && authSt.tabTextActive]}>Sign In</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[authSt.tab, mode === 'register' && authSt.tabActive]}
          onPress={() => { setMode('register'); setError(''); }}
          activeOpacity={0.8}
        >
          <Text style={[authSt.tabText, mode === 'register' && authSt.tabTextActive]}>Register</Text>
        </TouchableOpacity>
      </View>

      {/* Form */}
      <View style={authSt.form}>
        {mode === 'register' ? (
          <>
            <Text style={authSt.label}>Full Name *</Text>
            <TextInput style={authSt.input} value={name} onChangeText={setName} placeholder="Priya Mehta" placeholderTextColor="#BDB5AB" />
            <Text style={authSt.label}>City</Text>
            <TextInput style={authSt.input} value={city} onChangeText={setCity} placeholder="Your city or area" placeholderTextColor="#BDB5AB" />
          </>
        ) : null}

        <Text style={authSt.label}>Phone Number *</Text>
        <TextInput style={authSt.input} value={phone} onChangeText={setPhone} placeholder="9876543210" placeholderTextColor="#BDB5AB" keyboardType="phone-pad" />

        <Text style={authSt.label}>Password *</Text>
        <TextInput style={authSt.input} value={password} onChangeText={setPassword} placeholder="Min 6 characters" placeholderTextColor="#BDB5AB" secureTextEntry />

        {error ? <Text style={authSt.error}>{error}</Text> : null}

        <TouchableOpacity style={authSt.submitBtn} onPress={submit} activeOpacity={0.85} disabled={loading}>
          {loading
            ? <ActivityIndicator color={C.white} />
            : <Text style={authSt.submitText}>{mode === 'login' ? 'Sign In →' : 'Create Chef Account →'}</Text>}
        </TouchableOpacity>
      </View>

      <Text style={authSt.note}>
        {mode === 'register'
          ? 'Your account is registered with CHEF role and will receive buyer request notifications.'
          : 'Use your registered chef phone number and password.'}
      </Text>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  HOME SCREEN HELPERS
// ─────────────────────────────────────────────────────────────────────────
function HomeStatCard({
  label, value, variant = 'default', delay = 0, onPress,
}: {
  label: string; value: string; variant?: 'default' | 'earnings'; delay?: number; onPress?: () => void;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.88)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(anim, { toValue: 1, duration: 500, delay, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, delay, useNativeDriver: true, tension: 80, friction: 8 }),
    ]).start();
  }, []);

  const isEarnings = variant === 'earnings';
  const card = (
    <Animated.View style={[homeSt.statCard, isEarnings && homeSt.statCardEarnings, { opacity: anim, transform: [{ scale }] }]}>
      {isEarnings && <View style={homeSt.statGlow} />}
      <Text style={[homeSt.statValue, isEarnings && homeSt.statValueEarnings]}>{value}</Text>
      <Text style={[homeSt.statLabel, isEarnings && homeSt.statLabelEarnings]}>{label}</Text>
    </Animated.View>
  );
  if (onPress) return <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={{ flex: 1 }}>{card}</TouchableOpacity>;
  return card;
}

function HomeCulinaryCard({ todayCount, onPress }: { todayCount: number; onPress: () => void }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.06, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, []);
  return (
    <TouchableOpacity activeOpacity={0.9} style={homeSt.culinaryCard} onPress={onPress}>
      <View style={homeSt.culinaryStrip} />
      <View style={homeSt.culinaryContent}>
        <View style={homeSt.culinaryLeft}>
          <Text style={homeSt.culinaryTag}>{'🍳  CULINARY SKILLS'}</Text>
          <Text style={homeSt.culinaryTitle}>{'Show what you\'re\ncooking today'}</Text>
          <Text style={homeSt.culinarySubtitle}>
            {todayCount > 0
              ? `${todayCount} dish${todayCount > 1 ? 'es' : ''} added · Tap to update your live kitchen board`
              : "Add today's dishes so buyers can see your kitchen focus"}
          </Text>
        </View>
        <Animated.View style={[homeSt.todayBadge, { transform: [{ scale: pulse }] }]}>
          <Text style={homeSt.todayNumber}>{todayCount}</Text>
          <Text style={homeSt.todayLabel}>TODAY</Text>
        </Animated.View>
      </View>
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  HOME SCREEN
// ─────────────────────────────────────────────────────────────────────────
function HomeScreen({
  user, isAvailable, onToggleAvailability,
  locationLabel, geoRadius, hasGpsLocation, onOpenLocationSettings,
  todayMenu, onOpenSkills,
  requests, ignoredRequestIds, onIgnoreRequest, chefGeoRadius,
  activeOrders, dishOffers, acceptedDishOffers, earningsTotal, loading, refreshing,
  onRefresh, onRequestPress, onOrderPress,
  onViewAllOrders, onViewEarnings, onViewProfile,
  onOfferAccept, onOfferReject, onOfferCounter,
}: {
  user: UserProfile | null;
  isAvailable: boolean;
  locationLabel: string;
  geoRadius: number;
  hasGpsLocation: boolean;
  onOpenLocationSettings: () => void;
  todayMenu: TodayDish[];
  onOpenSkills: () => void;
  onToggleAvailability: (v: boolean) => void;
  requests: RequestItem[];
  ignoredRequestIds: string[];
  onIgnoreRequest: (id: string) => void;
  chefGeoRadius: number;
  activeOrders: OrderItem[];
  dishOffers: DishOffer[];
  acceptedDishOffers: PaidDishOffer[];
  earningsTotal: number;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRequestPress: (id: string) => void;
  onOrderPress: (id: string) => void;
  onViewAllOrders: () => void;
  onViewEarnings: () => void;
  onViewProfile: () => void;
  onOfferAccept: (id: string) => Promise<void>;
  onOfferReject: (id: string) => Promise<void>;
  onOfferCounter: (id: string, counterPrice: number, counterNote?: string) => Promise<void>;
}) {
  const liveDishOffers = dishOffers.filter((offer) => offer.status !== 'PAID');
  const visibleRequests = requests.filter((r) => !ignoredRequestIds.includes(r.id));
  const activeAcceptedDishOffers = acceptedDishOffers.filter((offer) => getPaidOfferOrderStatus(offer) !== 'DELIVERED');
  const activeWorkCount = activeOrders.length + activeAcceptedDishOffers.length;

  const headerY = useRef(new Animated.Value(-20)).current;
  const headerOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(headerY, { toValue: 0, duration: 600, useNativeDriver: true }),
      Animated.timing(headerOpacity, { toValue: 1, duration: 600, useNativeDriver: true }),
    ]).start();
  }, []);

  // counter-offer modal state
  const [counterOffer, setCounterOffer] = useState<DishOffer | null>(null);
  const [counterPrice, setCounterPrice] = useState('');
  const [counterNote, setCounterNote] = useState('');
  const [counterBusy, setCounterBusy] = useState(false);

  return (
    <ScrollView
      style={[ss.scroll, { backgroundColor: C.bg }]}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={homeSt.scrollContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.mint} />}
    >
      {/* Header */}
      <Animated.View style={[homeSt.header, { opacity: headerOpacity, transform: [{ translateY: headerY }] }]}>
        <View style={homeSt.brandWrap}>
          <View style={homeSt.brandRow}>
            <Text style={homeSt.brandFood}>food</Text>
            <Text style={homeSt.brandSood}>sood</Text>
          </View>
        </View>
        <TouchableOpacity onPress={onViewProfile} activeOpacity={0.8} style={homeSt.avatarWrapper}>
          <View style={homeSt.avatar}>
            <Text style={homeSt.avatarText}>{(user?.name?.[0] ?? 'C').toUpperCase()}</Text>
          </View>
          <View style={[homeSt.avatarOnline, { backgroundColor: isAvailable ? '#4ADE80' : '#9EB5AD' }]} />
        </TouchableOpacity>
      </Animated.View>

      {/* Location chips */}
      <View style={homeSt.locationRow}>
        <TouchableOpacity style={homeSt.locationChip} activeOpacity={0.8} onPress={onOpenLocationSettings}>
          <Text style={homeSt.locationPin}>📍</Text>
          <Text style={homeSt.locationText} numberOfLines={1} ellipsizeMode="tail">{locationLabel}</Text>
          <Text style={homeSt.locationCaret}> ▾</Text>
        </TouchableOpacity>
        <View style={homeSt.rangeChip}>
          <Text style={homeSt.rangeText}>{hasGpsLocation ? '🎯' : '📍'} {geoRadius} km</Text>
        </View>
      </View>

      {/* Taking Orders toggle */}
      <View style={homeSt.toggleCard}>
        <View style={homeSt.toggleLeft}>
          <View style={[homeSt.toggleDot, isAvailable && homeSt.toggleDotActive]} />
          <Text style={homeSt.toggleLabel}>Taking Orders</Text>
        </View>
        <Switch
          value={isAvailable}
          onValueChange={onToggleAvailability}
          trackColor={{ false: '#D1D9D6', true: C.primaryLight }}
          thumbColor={isAvailable ? C.mint : '#9EB5AD'}
          ios_backgroundColor="#D1D9D6"
        />
      </View>

      {/* Stat cards */}
      <View style={homeSt.statsRow}>
        <HomeStatCard label="ACTIVE ORDERS" value={String(activeWorkCount)} delay={100} onPress={onViewAllOrders} />
        <HomeStatCard label="NOTICES" value={String(visibleRequests.length + liveDishOffers.length)} delay={200} />
        <HomeStatCard
          label="EARNINGS"
          value={`\u20B9${earningsTotal >= 1000 ? `${(earningsTotal / 1000).toFixed(1)}k` : earningsTotal}`}
          variant="earnings"
          delay={300}
          onPress={onViewEarnings}
        />
      </View>

      {/* Culinary skills */}
      <HomeCulinaryCard todayCount={todayMenu.length} onPress={onOpenSkills} />

      {/* Active orders */}
      {activeWorkCount > 0 ? (
        <View style={homeSt.section}>
          <View style={homeSt.sectionHeader}>
            <Text style={homeSt.sectionTitle}>Active Orders</Text>
            <TouchableOpacity onPress={onViewAllOrders}><Text style={homeSt.seeAll}>See all →</Text></TouchableOpacity>
          </View>
          {activeOrders.slice(0, 2).map((order) => (
            <ActiveOrderCard key={order.id} order={order} onPress={() => onOrderPress(order.id)} />
          ))}
          {activeAcceptedDishOffers.slice(0, Math.max(0, 2 - activeOrders.length)).map((offer) => (
            <AcceptedOfferCard key={offer.id} offer={offer} />
          ))}
        </View>
      ) : null}

      {/* ── Unified Request Board ─────────────────────────────────────── */}
      {(() => {
        type BoardItem =
          | { kind: 'request'; data: RequestItem; ts: number }
          | { kind: 'offer';   data: DishOffer;   ts: number };

        const items: BoardItem[] = [
          ...visibleRequests.map((r): BoardItem => ({ kind: 'request', data: r, ts: new Date(r.createdAt).getTime() })),
          ...liveDishOffers.map((o): BoardItem => ({ kind: 'offer', data: o, ts: new Date(o.createdAt).getTime() })),
        ].sort((a, b) => b.ts - a.ts);

        const total = items.length;

        return (
          <>
            <View style={homeSt.sectionHeader}>
              <Text style={homeSt.sectionTitle}>Request Board</Text>
              <View style={homeSt.badge}>
                <Text style={homeSt.badgeText}>{total} live</Text>
              </View>
            </View>
            <View style={homeSt.requestCard}>
              <View style={homeSt.geoBar}>
                <Text style={homeSt.geoIcon}>🎯</Text>
                <Text style={homeSt.geoText}>
                  {hasGpsLocation
                    ? 'Showing buyer requests in your area'
                    : 'Set GPS location to filter nearby activity'}
                </Text>
                <TouchableOpacity onPress={onOpenLocationSettings}>
                  <Text style={homeSt.geoChange}>Change</Text>
                </TouchableOpacity>
              </View>
              {loading ? (
                <ActivityIndicator color={C.mint} style={{ margin: 40 }} />
              ) : total === 0 ? (
                <View style={homeSt.emptyState}>
                  <Text style={homeSt.emptyEmoji}>📌</Text>
                  <Text style={homeSt.emptyTitle}>{hasGpsLocation ? 'No nearby requests' : 'No buyer activity yet'}</Text>
                  <Text style={homeSt.emptySub}>
                    {hasGpsLocation ? 'Buyers haven\'t posted requests near you yet.' : 'Set your GPS location to filter nearby buyer activity.'}
                  </Text>
                </View>
              ) : (
                <View style={{ padding: 12 }}>
                  {items.map((item) =>
                    item.kind === 'request' ? (
                      <RequestCard
                        key={`req-${item.data.id}`}
                        req={item.data}
                        chefGeoRadius={chefGeoRadius}
                        onPress={() => onRequestPress(item.data.id)}
                        onIgnore={() => onIgnoreRequest(item.data.id)}
                      />
                    ) : (
                      <DishOfferCard
                        key={`offer-${item.data.id}`}
                        offer={item.data}
                        onAccept={() => onOfferAccept(item.data.id)}
                        onReject={() => onOfferReject(item.data.id)}
                        onCounter={() => {
                          setCounterOffer(item.data);
                          setCounterPrice(String(item.data.offerPrice));
                          setCounterNote('');
                        }}
                      />
                    )
                  )}
                </View>
              )}
            </View>
          </>
        );
      })()}

      <View style={{ height: 110 }} />

      {/* Counter-offer modal */}
      <Modal visible={counterOffer !== null} transparent animationType="fade">
        <View style={offerSt.overlay}>
          <View style={offerSt.sheet}>
            <Text style={offerSt.sheetTitle}>Counter Offer</Text>
            {counterOffer ? (
              <Text style={offerSt.sheetSub}>
                {counterOffer.dishEmoji} {counterOffer.dishName} — {counterOffer.plates} plate{counterOffer.plates > 1 ? 's' : ''} @ {'\u20B9'}{counterOffer.offerPrice}/plate
              </Text>
            ) : null}
            {counterOffer?.counterPrice ? (
              <View style={offerSt.lastCounterBanner}>
                <Text style={offerSt.lastCounterLabel}>YOUR LAST COUNTER</Text>
                <Text style={offerSt.lastCounterValue}>{'\u20B9'}{counterOffer.counterPrice}/plate</Text>
                <Text style={offerSt.lastCounterHint}>New counter must be below this</Text>
              </View>
            ) : null}
            <Text style={offerSt.fieldLabel}>YOUR PRICE / PLATE ({'\u20B9'})</Text>
            {(() => {
              const maxAllowed = counterOffer?.counterPrice ?? null;
              const entered = parseInt(counterPrice, 10);
              const tooHigh = maxAllowed !== null && !isNaN(entered) && entered >= maxAllowed;
              return (
                <>
                  <TextInput
                    style={[offerSt.input, tooHigh && offerSt.inputError]}
                    value={counterPrice}
                    onChangeText={setCounterPrice}
                    keyboardType="numeric"
                    placeholder={maxAllowed ? `Less than \u20B9${maxAllowed}` : 'e.g. 150'}
                    placeholderTextColor={C.warmGray}
                  />
                  {tooHigh ? (
                    <Text style={offerSt.errorText}>Must be below {'\u20B9'}{maxAllowed}</Text>
                  ) : null}
                </>
              );
            })()}
            <Text style={offerSt.fieldLabel}>NOTE (OPTIONAL)</Text>
            <TextInput
              style={[offerSt.input, { height: 72, textAlignVertical: 'top' }]}
              value={counterNote}
              onChangeText={setCounterNote}
              multiline
              placeholder="Explain your counter-offer..."
              placeholderTextColor={C.warmGray}
            />
            <View style={offerSt.btnRow}>
              <TouchableOpacity
                style={[offerSt.btn, offerSt.btnCancel]}
                onPress={() => setCounterOffer(null)}
              >
                <Text style={offerSt.btnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[offerSt.btn, offerSt.btnSend, counterBusy && { opacity: 0.6 }]}
                disabled={counterBusy}
                onPress={async () => {
                  const price = parseInt(counterPrice, 10);
                  if (!price || price < 1) return;
                  const maxAllowed = counterOffer?.counterPrice ?? null;
                  if (maxAllowed !== null && price >= maxAllowed) return;
                  setCounterBusy(true);
                  try {
                    await onOfferCounter(counterOffer!.id, price, counterNote || undefined);
                    setCounterOffer(null);
                  } finally {
                    setCounterBusy(false);
                  }
                }}
              >
                <Text style={offerSt.btnSendText}>{counterBusy ? 'Sending...' : 'Send Counter'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  REQUEST DETAIL + QUOTE SCREEN
// ─────────────────────────────────────────────────────────────────────────
function RequestDetailScreen({
  requestId, chefId, cookingStyle,
  onBack, onQuoteSubmitted,
}: {
  requestId: string;
  chefId: string;
  cookingStyle?: string;
  onBack: () => void;
  onQuoteSubmitted: () => void;
}) {
  const [req, setReq]           = useState<RequestItem | null>(null);
  const [loading, setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requoteMode, setRequoteMode] = useState(false);

  // Quote form state
  const [price, setPrice]       = useState('');
  const [cookTime, setCookTime] = useState('~2 hrs');
  const [delivery, setDelivery] = useState<'pickup' | 'delivery' | 'both'>('both');
  const [message, setMessage]   = useState('');
  const [error, setError]       = useState('');

  // Existing quote (if already submitted)
  const myQuote = req?.quotes?.find((q) => q.chefId === chefId && q.status !== 'WITHDRAWN');

  useEffect(() => {
    Requests.get(requestId)
      .then((r) => {
        setReq(r);
        if (r.budget) setPrice(String(r.budget));
      })
      .catch(() => setError('Failed to load request'))
      .finally(() => setLoading(false));
  }, [requestId]);

  useEffect(() => {
    if (!myQuote) return;
    setPrice(String(myQuote.counterOffer ?? myQuote.price));
    setCookTime(myQuote.cookTime);
    setDelivery((myQuote.delivery as 'pickup' | 'delivery' | 'both') ?? 'both');
    setMessage(myQuote.message ?? '');
  }, [myQuote]);

  const submitQuote = async () => {
    setError('');
    const p = parseInt(price, 10);
    if (!p || p <= 0) { setError('Enter a valid price'); return; }
    if (!cookTime) { setError('Enter estimated cook time'); return; }
    setSubmitting(true);
    try {
      let updatedQuote: QuoteItem;
      if (myQuote && requoteMode) {
        updatedQuote = await Quotes.update(myQuote.id, {
          price: p,
          cookTime,
          delivery,
          message: message || undefined,
          style: cookingStyle ?? undefined,
        });
        setReq((current) => current ? ({
          ...current,
          quotes: (current.quotes ?? []).map((quote) => quote.id === updatedQuote.id ? { ...quote, ...updatedQuote } : quote),
        }) : current);
        Alert.alert('Counter Sent', 'The buyer will see your updated quote.', [{ text: 'OK', onPress: onQuoteSubmitted }]);
      } else {
        updatedQuote = await Requests.submitQuote(requestId, {
          price: p, cookTime, delivery, message: message || undefined,
          style: cookingStyle ?? undefined,
        });
        setReq((current) => current ? ({
          ...current,
          quotes: [updatedQuote, ...(current.quotes ?? []).filter((quote) => quote.id !== updatedQuote.id)],
          quotesCount: (current.quotesCount ?? 0) + ((current.quotes ?? []).some((quote) => quote.id === updatedQuote.id) ? 0 : 1),
        }) : current);
        Alert.alert('Quote Sent! 🎉', 'The buyer will be notified.', [{ text: 'OK', onPress: onQuoteSubmitted }]);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to submit quote');
    } finally {
      setSubmitting(false);
    }
  };

  const withdrawQuote = async () => {
    if (!myQuote) return;
    Alert.alert('Withdraw Quote', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Withdraw', style: 'destructive',
        onPress: async () => {
          await Quotes.withdraw(myQuote.id);
          onBack();
        },
      },
    ]);
  };

  const acceptBuyerCounter = async () => {
    if (!myQuote) return;
    try {
      await Quotes.acceptCounter(myQuote.id);
      Alert.alert('Counter Accepted', 'The order has been confirmed for the buyer.', [{ text: 'OK', onPress: onQuoteSubmitted }]);
    } catch (e: unknown) {
      Alert.alert('Action failed', e instanceof Error ? e.message : 'Could not accept buyer counter.');
    }
  };

  const rejectBuyerCounter = async () => {
    if (!myQuote) return;
    try {
      await Quotes.rejectCounter(myQuote.id);
      Alert.alert('Counter Rejected', 'Your quote has been closed for this request.', [{ text: 'OK', onPress: onQuoteSubmitted }]);
    } catch (e: unknown) {
      Alert.alert('Action failed', e instanceof Error ? e.message : 'Could not reject buyer counter.');
    }
  };

  if (loading) return <CenteredLoader />;
  if (!req) return <ErrorView message={error || 'Request not found'} onBack={onBack} />;

  const canQuote = req.status === 'OPEN' || req.status === 'NEGOTIATING';
  const isThaliRequest = req.category.toLowerCase() === 'thali';
  const qtySummary = isThaliRequest ? `${req.people} plate${req.people > 1 ? 's' : ''}` : `${req.qty} kg`;
  const chefCountersLeft = Math.max(0, MAX_REQUEST_QUOTES_PER_SIDE - (myQuote?.chefQuoteCount ?? 1));
  const buyerCountersLeft = Math.max(0, (MAX_REQUEST_QUOTES_PER_SIDE - 1) - (myQuote?.buyerCounterCount ?? 0));

  return (
    <>
      <View style={ss.header}>
        <TouchableOpacity style={ss.backBtn} onPress={onBack} activeOpacity={0.75}>
          <Text style={ss.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={ss.headerTitle}>Request Details</Text>
        <StatusPill status={req.status} />
      </View>

      <ScrollView style={ss.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 18, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        {/* Dish info */}
        <View style={rdSt.dishCard}>
          <View style={rdSt.dishTop}>
            <View style={rdSt.dishEmojiWrap}>
              <Text style={rdSt.dishEmoji}>{CATEGORY_EMOJI[req.category] ?? '🍽'}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={rdSt.dishName}>{req.dishName}</Text>
              <Text style={rdSt.dishSub}>Posted {timeAgo(req.createdAt)}{req.distanceKm != null ? ` · ${req.distanceKm} km away` : ''}</Text>
            </View>
            <Text style={rdSt.budgetAmt}>₹{req.budget}</Text>
          </View>

          {/* Specs grid */}
          <View style={rdSt.specGrid}>
            {[
              { label: 'Qty',      val: qtySummary },
              { label: isThaliRequest ? 'Plates' : 'People',   val: isThaliRequest ? `${req.people}` : `${req.people} pax` },
              { label: 'Spice',    val: SPICE_LABEL[req.spiceLevel] ?? req.spiceLevel },
              { label: 'Delivery', val: DELIVERY_LABEL[req.delivery] ?? req.delivery },
            ].map((s) => (
              <View key={s.label} style={rdSt.specItem}>
                <Text style={rdSt.specVal}>{s.val}</Text>
                <Text style={rdSt.specLabel}>{s.label}</Text>
              </View>
            ))}
          </View>

          {/* Preferences tags */}
          {req.preferences.length > 0 ? (
            <View style={ss.tagsRow}>
              {req.preferences.map((p) => (
                <View key={p} style={ss.tag}><Text style={ss.tagText}>{p}</Text></View>
              ))}
            </View>
          ) : null}

          {req.notes ? (
            <View style={rdSt.noteBox}>
              <Text style={rdSt.noteText}>💬 "{req.notes}"</Text>
            </View>
          ) : null}
        </View>

        {/* Buyer info */}
        <View style={rdSt.buyerRow}>
          <View style={rdSt.buyerAv}>
            <Text style={rdSt.buyerAvText}>{req.user.name[0]}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={rdSt.buyerName}>{req.user.name}</Text>
            {req.user.city ? <Text style={rdSt.buyerCity}>📍 {req.user.city}</Text> : null}
          </View>
          <View style={rdSt.buyerRating}>
            <Text style={rdSt.buyerRatingText}>⭐ {req.user.rating}</Text>
          </View>
        </View>

        {/* Already quoted — show quote status */}
        {myQuote ? (
          <View style={rdSt.myQuoteCard}>
            <View style={rdSt.myQuoteTop}>
              <Text style={rdSt.myQuoteTitle}>Your Quote</Text>
              <StatusPill status={myQuote.status} />
            </View>
            <Text style={rdSt.myQuotePrice}>₹{myQuote.price}</Text>
            <Text style={rdSt.myQuoteMeta}>{myQuote.cookTime} · {DELIVERY_LABEL[myQuote.delivery] ?? myQuote.delivery}</Text>
            <View style={rdSt.counterMetaRow}>
              <Text style={rdSt.counterMetaText}>Your quotes left: {chefCountersLeft}</Text>
              <Text style={rdSt.counterMetaText}>Buyer quotes left: {buyerCountersLeft}</Text>
            </View>
            {myQuote.counterOffer ? (
              <View style={rdSt.counterBox}>
                <Text style={rdSt.counterText}>💬 Buyer counter-offered: ₹{myQuote.counterOffer}</Text>
              </View>
            ) : null}
            {myQuote.status === 'COUNTERED' ? (
              <View style={rdSt.actionRow}>
                <TouchableOpacity style={[offerSt.actionBtn, offerSt.actionReject]} activeOpacity={0.8} onPress={rejectBuyerCounter}>
                  <Text style={offerSt.actionRejectText}>Withdraw</Text>
                </TouchableOpacity>
                {chefCountersLeft > 0 ? (
                  <TouchableOpacity
                    style={[offerSt.actionBtn, offerSt.actionCounter]}
                    activeOpacity={0.8}
                    onPress={() => {
                      setRequoteMode(true);
                      setError('');
                    }}
                  >
                    <Text style={offerSt.actionCounterText}>Counter</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={[offerSt.actionBtn, offerSt.actionAccept]} activeOpacity={0.8} onPress={acceptBuyerCounter}>
                  <Text style={offerSt.actionAcceptText}>Accept</Text>
                </TouchableOpacity>
              </View>
            ) : myQuote.status !== 'ACCEPTED' ? (
              <TouchableOpacity style={rdSt.withdrawBtn} onPress={withdrawQuote} activeOpacity={0.75}>
                <Text style={rdSt.withdrawBtnText}>Withdraw Quote</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {/* Quote form — initial quote or chef counter back after buyer counter */}
        {canQuote && (!myQuote || (requoteMode && chefCountersLeft > 0)) ? (
          <View style={rdSt.quoteForm}>
            <Text style={rdSt.formTitle}>{requoteMode ? 'Counter Buyer Offer' : 'Submit Your Quote'}</Text>
            {requoteMode ? <Text style={rdSt.limitHint}>You have {chefCountersLeft} quote{chefCountersLeft === 1 ? '' : 's'} left in this negotiation.</Text> : null}

            <Text style={ss.fieldLabel}>Your Price (₹)</Text>
            <View style={rdSt.priceRow}>
              <Text style={rdSt.rupee}>₹</Text>
              <TextInput
                style={rdSt.priceInput}
                value={price}
                onChangeText={setPrice}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor="#BDB5AB"
              />
            </View>
            {req.budget ? <Text style={rdSt.budgetHint}>Buyer's budget: ₹{req.budget}</Text> : null}

            <Text style={ss.fieldLabel}>Estimated Cook Time</Text>
            <View style={rdSt.cookTimeRow}>
              {['~1 hr', '~1.5 hrs', '~2 hrs', '~2.5 hrs', '~3 hrs'].map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[rdSt.cookChip, cookTime === t && rdSt.cookChipActive]}
                  onPress={() => setCookTime(t)}
                  activeOpacity={0.75}
                >
                  <Text style={[rdSt.cookChipText, cookTime === t && rdSt.cookChipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={ss.fieldLabel}>Delivery Option</Text>
            <View style={ss.chipRow}>
              {(['pickup', 'delivery', 'both'] as const).map((opt) => (
                <TouchableOpacity
                  key={opt}
                  style={[ss.chip, delivery === opt && ss.chipActive]}
                  onPress={() => setDelivery(opt)}
                  activeOpacity={0.75}
                >
                  <Text style={[ss.chipText, delivery === opt && ss.chipTextActive]}>
                    {DELIVERY_LABEL[opt]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={ss.fieldLabel}>Message to Buyer (optional)</Text>
            <TextInput
              style={rdSt.msgInput}
              value={message}
              onChangeText={setMessage}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              placeholder="e.g. I use fresh locally sourced chicken. Can deliver by 7 PM."
              placeholderTextColor="#BDB5AB"
            />

            {error ? <Text style={ss.errorText}>{error}</Text> : null}

            <View style={rdSt.formActionRow}>
              {requoteMode ? (
                <TouchableOpacity
                  style={rdSt.formSecondaryBtn}
                  activeOpacity={0.8}
                  onPress={() => {
                    setRequoteMode(false);
                    setError('');
                    if (myQuote) {
                      setPrice(String(myQuote.counterOffer ?? myQuote.price));
                      setCookTime(myQuote.cookTime);
                      setDelivery((myQuote.delivery as 'pickup' | 'delivery' | 'both') ?? 'both');
                      setMessage(myQuote.message ?? '');
                    }
                  }}
                >
                  <Text style={rdSt.formSecondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[rdSt.submitBtn, requoteMode && { flex: 1 }]}
                onPress={submitQuote}
                activeOpacity={0.85}
                disabled={submitting}
              >
                {submitting
                  ? <ActivityIndicator color={C.white} />
                  : <Text style={rdSt.submitBtnText}>{requoteMode ? `Send Counter ₹${price || '—'}` : `Send Quote ₹${price || '—'}`}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {!canQuote && !myQuote ? (
          <View style={rdSt.closedBox}>
            <Text style={rdSt.closedText}>This request is no longer accepting new quotes.</Text>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  ORDERS SCREEN
// ─────────────────────────────────────────────────────────────────────────
function OrdersScreen({
  onBack, onOrderPress,
}: {
  onBack: () => void;
  onOrderPress: (id: string) => void;
}) {
  const [orders, setOrdersState] = useState<OrderItem[]>([]);
  const [acceptedOffers, setAcceptedOffers] = useState<PaidDishOffer[]>([]);
  const [tab, setTab]            = useState<'active' | 'history'>('active');
  const [loading, setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [data, offerData] = await Promise.all([
        Orders.list(),
        Offers.list(['PAID']),
      ]);
      setOrdersState(data);
      setAcceptedOffers(offerData.filter((offer): offer is PaidDishOffer => offer.status === 'PAID'));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const active  = orders.filter((o) => !['DELIVERED', 'CANCELLED'].includes(o.status));
  const history = orders.filter((o) =>  ['DELIVERED', 'CANCELLED'].includes(o.status));
  const activeAcceptedOffers = acceptedOffers.filter((offer) => getPaidOfferOrderStatus(offer) !== 'DELIVERED');
  const historyAcceptedOffers = acceptedOffers.filter((offer) => getPaidOfferOrderStatus(offer) === 'DELIVERED');
  const activeCount = active.length + activeAcceptedOffers.length;

  return (
    <>
      <View style={ss.header}>
        <TouchableOpacity style={ss.backBtn} onPress={onBack} activeOpacity={0.75}>
          <Text style={ss.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={ss.headerTitle}>My Orders</Text>
        <View style={{ width: 34 }} />
      </View>

      {/* Tab bar */}
      <View style={ordSt.tabBar}>
        <TouchableOpacity style={[ordSt.tabBtn, tab === 'active' && ordSt.tabBtnActive]} onPress={() => setTab('active')} activeOpacity={0.8}>
          <Text style={[ordSt.tabBtnText, tab === 'active' && ordSt.tabBtnTextActive]}>Active ({activeCount})</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[ordSt.tabBtn, tab === 'history' && ordSt.tabBtnActive]} onPress={() => setTab('history')} activeOpacity={0.8}>
          <Text style={[ordSt.tabBtnText, tab === 'history' && ordSt.tabBtnTextActive]}>History ({history.length + historyAcceptedOffers.length})</Text>
        </TouchableOpacity>
      </View>

      {loading ? <CenteredLoader /> : (
        <ScrollView
          style={ss.scroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: 18, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.mint} />}
        >
          {(tab === 'active' ? activeCount === 0 : (history.length + historyAcceptedOffers.length) === 0) ? (
            <View style={ordSt.empty}>
              <Text style={ordSt.emptyEmoji}>{tab === 'active' ? '📦' : '🕐'}</Text>
              <Text style={ordSt.emptyText}>{tab === 'active' ? 'No active orders right now' : 'No completed orders yet'}</Text>
            </View>
          ) : tab === 'active' ? (
            <>
              {active.map((order) => (
                <OrderCard key={order.id} order={order} onPress={() => onOrderPress(order.id)} />
              ))}
              {activeAcceptedOffers.map((offer) => (
                <ManagedAcceptedOfferCard
                  key={offer.id}
                  offer={offer}
                  onUpdateStatus={async (id, status) => {
                    const updated = await Offers.updateOrderStatus(id, status);
                    setAcceptedOffers((curr) => curr.map((item) => item.id === id ? updated as PaidDishOffer : item));
                  }}
                />
              ))}
            </>
          ) : (
            <>
              {history.map((order) => (
                <OrderCard key={order.id} order={order} onPress={() => onOrderPress(order.id)} />
              ))}
              {historyAcceptedOffers.map((offer) => (
                <ManagedAcceptedOfferCard key={offer.id} offer={offer} />
              ))}
            </>
          )}
        </ScrollView>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  ORDER DETAIL SCREEN
// ─────────────────────────────────────────────────────────────────────────
function OrderDetailScreen({
  orderId, onBack,
}: {
  orderId: string;
  onBack: () => void;
}) {
  const [order, setOrder] = useState<OrderItem | null>(null);
  const [loading, setLoading]     = useState(true);
  const [updating, setUpdating]   = useState(false);
  const [error, setError]         = useState('');
  const [blockedByMe, setBlockedByMe] = useState(false);
  const [, setTick]               = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await Orders.get(orderId);
      setOrder(data);
      const relation = await Moderation.relation(data.buyer.id).catch(() => ({ blocked: false, blockedByMe: false }));
      setBlockedByMe(relation.blockedByMe);
    } catch { setError('Failed to load order'); }
    finally { setLoading(false); }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => setTick((current) => current + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const updateStatus = async (next: OrderStatus) => {
    if (!order) return;
    setUpdating(true);
    try {
      const updated = await Orders.updateStatus(order.id, next);
      setOrder(updated);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Update failed');
    } finally {
      setUpdating(false);
    }
  };

  const sendBuyerReport = (reason: ModerationReason) => {
    if (!order) return;
    Moderation.report({ targetType: 'USER', targetId: order.buyer.id, reason })
      .then(() => Alert.alert('Reported', 'The buyer was sent to the moderation queue.'))
      .catch((e: unknown) => Alert.alert('Report failed', e instanceof Error ? e.message : 'Could not send report.'));
  };

  const openBuyerReportMenu = () => {
    Alert.alert('Report buyer', 'Choose a reason for this report.', [
      { text: 'Harassment', onPress: () => sendBuyerReport('HARASSMENT') },
      { text: 'Spam', onPress: () => sendBuyerReport('SPAM') },
      { text: 'Impersonation', onPress: () => sendBuyerReport('IMPERSONATION') },
      { text: 'Other', onPress: () => sendBuyerReport('OTHER') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const toggleBuyerBlock = () => {
    if (!order) return;
    const action = blockedByMe ? Moderation.unblockUser : Moderation.blockUser;
    Alert.alert(
      blockedByMe ? 'Unblock buyer' : 'Block buyer',
      blockedByMe
        ? 'This buyer will be visible again.'
        : 'Blocking will stop this buyer from interacting with you where the app enforces user blocks.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: blockedByMe ? 'Unblock' : 'Block',
          style: blockedByMe ? 'default' : 'destructive',
          onPress: () => {
            action(order.buyer.id)
              .then(() => {
                setBlockedByMe((prev) => !prev);
                Alert.alert(blockedByMe ? 'Buyer unblocked' : 'Buyer blocked');
              })
              .catch((e: unknown) => Alert.alert('Action failed', e instanceof Error ? e.message : 'Could not update block status.'));
          },
        },
      ],
    );
  };

  if (loading) return <CenteredLoader />;
  if (!order)  return <ErrorView message={error || 'Order not found'} onBack={onBack} />;

  const meta = order.request.delivery === 'pickup' && order.status === 'READY'
    ? { ...ORDER_STATUS_META.READY, next: 'DELIVERED' as OrderStatus, nextLabel: '📦 Mark Delivered' }
    : ORDER_STATUS_META[order.status];
  const isTerminal = ['DELIVERED', 'CANCELLED'].includes(order.status);
  const cookingCountdown = order.status === 'COOKING' ? countdownTo(order.readyAt) : null;

  // Build timeline
  const TIMELINE: OrderStatus[] = order.request.delivery === 'pickup'
    ? ['CONFIRMED', 'COOKING', 'READY', 'DELIVERED']
    : ['CONFIRMED', 'COOKING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'];
  const currentIdx = TIMELINE.indexOf(order.status as OrderStatus);

  return (
    <>
      <View style={ss.header}>
        <TouchableOpacity style={ss.backBtn} onPress={onBack} activeOpacity={0.75}>
          <Text style={ss.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={ss.headerTitle}>Order #{order.id.slice(-6).toUpperCase()}</Text>
        <StatusPill status={order.status} />
      </View>

      <ScrollView style={ss.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 18, paddingBottom: 40 }}>

        {/* Order summary */}
        <View style={odSt.summaryCard}>
          <View style={odSt.summaryTop}>
            <View style={odSt.dishIcon}>
              <Text style={{ fontSize: 26 }}>{CATEGORY_EMOJI[order.request.category] ?? '🍽'}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={odSt.dishName}>{order.request.dishName}</Text>
              <Text style={odSt.dishMeta}>
                {order.request.qty} kg · {order.request.people} people · {SPICE_LABEL[order.request.spiceLevel] ?? order.request.spiceLevel}
              </Text>
              {order.request.preferences.length > 0 ? (
                <View style={ss.tagsRow}>
                  {order.request.preferences.map((p) => (
                    <View key={p} style={ss.tag}><Text style={ss.tagText}>{p}</Text></View>
                  ))}
                </View>
              ) : null}
            </View>
            <View style={odSt.priceBox}>
              <Text style={odSt.priceAmt}>₹{order.finalPrice}</Text>
              <Text style={odSt.priceLabel}>Agreed</Text>
            </View>
          </View>

          {/* Delivery info */}
          <View style={odSt.deliveryRow}>
            <Text style={odSt.deliveryText}>
              {DELIVERY_LABEL[order.request.delivery] ?? order.request.delivery}
            </Text>
            {order.address ? <Text style={odSt.addressText}>📍 {order.address}</Text> : null}
          </View>
        </View>

        {/* Buyer info */}
        <View style={odSt.buyerCard}>
          <View style={odSt.buyerAv}>
            <Text style={odSt.buyerAvText}>{order.buyer.name[0]}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={odSt.buyerName}>{order.buyer.name}</Text>
            <View style={odSt.buyerActionRow}>
              <TouchableOpacity style={odSt.buyerActionBtn} activeOpacity={0.8} onPress={openBuyerReportMenu}>
                <Text style={odSt.buyerActionText}>Report Buyer</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[odSt.buyerActionBtn, blockedByMe && odSt.buyerActionBtnActive]} activeOpacity={0.8} onPress={toggleBuyerBlock}>
                <Text style={odSt.buyerActionText}>{blockedByMe ? 'Unblock Buyer' : 'Block Buyer'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={odSt.buyerPhone}>📞 {order.buyer.phone}</Text>
          </View>
          <TouchableOpacity style={odSt.callBtn} activeOpacity={0.8}>
            <Text style={odSt.callBtnText}>Call</Text>
          </TouchableOpacity>
        </View>

        {/* Order timeline */}
        <View style={odSt.timelineCard}>
          <Text style={odSt.timelineTitle}>Order Progress</Text>
          {cookingCountdown ? (
            <View style={odSt.timerBanner}>
              <Text style={odSt.timerBannerText}>🍳 Ready in {cookingCountdown}</Text>
            </View>
          ) : null}
          <View style={odSt.timeline}>
            {TIMELINE.map((s, i) => {
              const done    = i <= currentIdx;
              const current = i === currentIdx;
              return (
                <View key={s} style={odSt.timelineRow}>
                  <View style={odSt.timelineDotCol}>
                    <View style={[odSt.timelineDot, done && odSt.timelineDotDone, current && odSt.timelineDotCurrent]} />
                    {i < TIMELINE.length - 1 ? (
                      <View style={[odSt.timelineLine, done && odSt.timelineLineDone]} />
                    ) : null}
                  </View>
                  <Text style={[odSt.timelineLabel, done && odSt.timelineLabelDone]}>
                    {ORDER_STATUS_META[s]?.label ?? s}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Review (if delivered and reviewed) */}
        {order.review ? (
          <View style={odSt.reviewCard}>
            <Text style={odSt.reviewTitle}>Buyer Review</Text>
            <View style={ss.tagsRow}>
              {[1,2,3,4,5].map((i) => (
                <Text key={i} style={{ color: i <= order.review!.rating ? C.turmeric : C.border, fontSize: 18 }}>★</Text>
              ))}
            </View>
            {order.review.comment ? <Text style={odSt.reviewComment}>"{order.review.comment}"</Text> : null}
          </View>
        ) : null}

        {/* Primary action button */}
        {!isTerminal && meta?.next ? (
          <TouchableOpacity
            style={[odSt.actionBtn, { backgroundColor: meta.color }]}
            onPress={() => updateStatus(meta.next!)}
            activeOpacity={0.85}
            disabled={updating}
          >
            {updating
              ? <ActivityIndicator color={C.white} />
              : <Text style={odSt.actionBtnText}>{meta.nextLabel}</Text>}
          </TouchableOpacity>
        ) : null}

        <Text style={odSt.orderedAt}>Ordered {timeAgo(order.createdAt)}</Text>
      </ScrollView>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  EARNINGS SCREEN
// ─────────────────────────────────────────────────────────────────────────
function EarningsScreen({
  user, paidOffers, onBack,
}: {
  user: UserProfile | null;
  paidOffers: PaidDishOffer[];
  onBack: () => void;
}) {
  const totalOrders = paidOffers.length;
  const avgOrder    = totalOrders > 0 ? Math.round(paidOffers.reduce((sum, offer) => sum + ((offer.agreedPrice ?? offer.offerPrice) * offer.plates), 0) / totalOrders) : 0;
  const totalEarned = paidOffers.reduce((sum, offer) => sum + ((offer.agreedPrice ?? offer.offerPrice) * offer.plates), 0);
  const thisMonth   = Math.round(totalEarned * 0.14);

  const breakdown = [
    { label: 'Orders This Month',  value: Math.round(totalOrders * 0.14) },
    { label: 'Avg Order Value',    value: `₹${avgOrder}` },
    { label: 'Platform Fee (8%)',  value: `-₹${Math.round(thisMonth * 0.08)}` },
    { label: 'Net This Month',     value: `₹${Math.round(thisMonth * 0.92).toLocaleString()}`, highlight: true },
  ];

  return (
    <>
      <View style={ss.header}>
        <TouchableOpacity style={ss.backBtn} onPress={onBack} activeOpacity={0.75}>
          <Text style={ss.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={ss.headerTitle}>Earnings</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView style={ss.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 18, paddingBottom: 40 }}>

        {/* Hero card */}
        <View style={earnSt.heroCard}>
          <Text style={earnSt.heroLabel}>Total Earned</Text>
          <Text style={earnSt.heroAmt}>₹{totalEarned.toLocaleString()}</Text>
          <Text style={earnSt.heroSub}>{totalOrders} completed orders · ⭐ {user?.rating ?? 0} rating</Text>
          <TouchableOpacity style={earnSt.payoutBtn} activeOpacity={0.85}>
            <Text style={earnSt.payoutBtnText}>Request Payout →</Text>
          </TouchableOpacity>
        </View>

        {/* This month */}
        <View style={earnSt.monthCard}>
          <Text style={earnSt.monthTitle}>📅 This Month</Text>
          {breakdown.map((row) => (
            <View key={row.label} style={[earnSt.breakdownRow, row.highlight && earnSt.breakdownRowHL]}>
              <Text style={[earnSt.breakdownLabel, row.highlight && earnSt.breakdownLabelHL]}>{row.label}</Text>
              <Text style={[earnSt.breakdownVal, row.highlight && earnSt.breakdownValHL]}>{row.value}</Text>
            </View>
          ))}
        </View>

        {/* Tips */}
        <View style={earnSt.tipCard}>
          <Text style={earnSt.tipTitle}>💡 Earn More</Text>
          {[
            { icon: '⭐', text: 'Maintain 4.8+ rating to get priority placement in search' },
            { icon: '⚡', text: 'Respond to requests within 15 minutes for a higher match rate' },
            { icon: '📸', text: 'Add kitchen photos — chefs with photos earn 2× more' },
          ].map((tip) => (
            <View key={tip.text} style={earnSt.tipRow}>
              <Text style={earnSt.tipIcon}>{tip.icon}</Text>
              <Text style={earnSt.tipText}>{tip.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  PROFILE SCREEN
// ─────────────────────────────────────────────────────────────────────────
function ProfileScreen({
  user, isAvailable, onToggleAvailability,
  locationLabel, hasGpsLocation, geoRadius, onOpenLocationSettings,
  onOpenTodayBoard, onBack, onLogout, onSaved,
}: {
  user: UserProfile | null;
  isAvailable: boolean;
  locationLabel: string;
  hasGpsLocation: boolean;
  geoRadius: number;
  onOpenLocationSettings: () => void;
  onToggleAvailability: (v: boolean) => void;
  onOpenTodayBoard: () => void;
  onBack: () => void;
  onLogout: () => void;
  onSaved: (u: UserProfile) => void;
}) {
  const [name, setName]               = useState(user?.name ?? '');
  const [bio, setBio]                 = useState(user?.bio ?? '');
  const [style, setStyle]             = useState(user?.cookingStyle ?? '');
  const [city, setCity]               = useState(user?.city ?? '');
  const [avatarUrl, setAvatarUrl]     = useState(user?.avatar ?? '');
  const [coverImageUrl, setCoverImageUrl] = useState(user?.coverImage ?? '');
  const [kitchenImages, setKitchenImages] = useState<string[]>(user?.kitchenImages ?? []);
  const [uploadingIdx, setUploadingIdx]   = useState<number | 'avatar' | 'cover' | null>(null);
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);

  // Only sync non-image fields from the server response.
  // kitchenImages are managed locally and auto-persisted after each upload,
  // so we never overwrite them from a server response that may be missing the field.
  useEffect(() => {
    setName(user?.name ?? '');
    setBio(user?.bio ?? '');
    setStyle(user?.cookingStyle ?? '');
    setCity(user?.city ?? '');
    setAvatarUrl(user?.avatar ?? '');
    setCoverImageUrl(user?.coverImage ?? '');
    if (user?.kitchenImages?.length) {
      setKitchenImages(user.kitchenImages);
    }
  }, [user]);

  const uploadProfileImage = async (kind: 'avatar' | 'cover', uri: string) => {
    setUploadingIdx(kind);
    try {
      const compressed = await compressToTargetKB(uri, kind === 'avatar' ? 10 : 30);
      const imageData = `data:image/jpeg;base64,${compressed.base64}`;
      const { url } = await Users.uploadKitchenImage(imageData);
      await Moderation.acceptPolicy().catch(() => undefined);
      if (kind === 'avatar') {
        setAvatarUrl(url);
        const updated = await Users.updateMe({ avatar: url });
        onSaved({ ...updated, avatar: url, coverImage: updated.coverImage ?? coverImageUrl, kitchenImages: updated.kitchenImages?.length ? updated.kitchenImages : kitchenImages });
      } else {
        setCoverImageUrl(url);
        const updated = await Users.updateMe({ coverImage: url });
        onSaved({ ...updated, coverImage: url, avatar: updated.avatar ?? avatarUrl, kitchenImages: updated.kitchenImages?.length ? updated.kitchenImages : kitchenImages });
      }
    } catch {
      Alert.alert('Error', `Could not upload ${kind === 'avatar' ? 'profile photo' : 'cover image'}. Try again.`);
    } finally {
      setUploadingIdx(null);
    }
  };

  const pickProfileImage = async (kind: 'avatar' | 'cover') => {
    const title = kind === 'avatar' ? 'Add Chef Photo' : 'Add Cover Image';
    const aspect: [number, number] = kind === 'avatar' ? [1, 1] : [16, 9];
    Alert.alert(title, 'Choose source', [
      {
        text: 'Camera', onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) { Alert.alert('Camera permission required'); return; }
          const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: true, aspect });
          if (!result.canceled && result.assets[0]) await uploadProfileImage(kind, result.assets[0].uri);
        },
      },
      {
        text: 'Gallery', onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) { Alert.alert('Gallery permission required'); return; }
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: true, aspect });
          if (!result.canceled && result.assets[0]) await uploadProfileImage(kind, result.assets[0].uri);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const pickKitchenImage = async (idx: number) => {
    Alert.alert('Add Kitchen Photo', 'Choose source', [
      {
        text: 'Camera', onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) { Alert.alert('Camera permission required'); return; }
          const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: true, aspect: [4, 3] });
          if (!result.canceled && result.assets[0]) await uploadKitchenSlot(idx, result.assets[0].uri);
        },
      },
      {
        text: 'Gallery', onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) { Alert.alert('Gallery permission required'); return; }
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: true, aspect: [4, 3] });
          if (!result.canceled && result.assets[0]) await uploadKitchenSlot(idx, result.assets[0].uri);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const uploadKitchenSlot = async (idx: number, uri: string) => {
    setUploadingIdx(idx);
    try {
      const compressed = await compressToTargetKB(uri, 30);
      const imageData = `data:image/jpeg;base64,${compressed.base64}`;
      const { url } = await Users.uploadKitchenImage(imageData);
      // Build the new array so we can both set state AND auto-persist in one step
      const newImages = [...kitchenImages];
      newImages[idx] = url;
      setKitchenImages(newImages);
      // Auto-persist immediately — buyer app reflects it without needing a manual Save
      await Moderation.acceptPolicy().catch(() => undefined);
      const updated = await Users.updateMe({ kitchenImages: newImages });
      if (updated.kitchenImages?.length) onSaved(updated);
    } catch {
      Alert.alert('Error', 'Could not upload image. Try again.');
    } finally {
      setUploadingIdx(null);
    }
  };

  const removeKitchenImage = async (idx: number) => {
    const newImages = kitchenImages.filter((_, i) => i !== idx);
    setKitchenImages(newImages);
    try {
      await Moderation.acceptPolicy().catch(() => undefined);
      const updated = await Users.updateMe({ kitchenImages: newImages });
      if (updated) onSaved(updated);
    } catch { /* non-critical */ }
  };

  const save = async () => {
    setSaving(true);
    try {
      await Moderation.acceptPolicy().catch(() => undefined);
      const updated = await Users.updateMe({ name, bio, cookingStyle: style, city, avatar: avatarUrl || undefined, coverImage: coverImageUrl || undefined, kitchenImages });
      // Preserve local kitchenImages if server response omits them (stale backend)
      onSaved({
        ...updated,
        avatar: updated.avatar ?? avatarUrl,
        coverImage: updated.coverImage ?? coverImageUrl,
        kitchenImages: updated.kitchenImages?.length ? updated.kitchenImages : kitchenImages,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  return (
    <>
      <View style={ss.header}>
        <TouchableOpacity style={ss.backBtn} onPress={onBack} activeOpacity={0.75}>
          <Text style={ss.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={ss.headerTitle}>My Profile</Text>
        <TouchableOpacity style={profSt.saveBtn} onPress={save} activeOpacity={0.85} disabled={saving}>
          {saving
            ? <ActivityIndicator color={C.white} size="small" />
            : <Text style={profSt.saveBtnText}>{saved ? '✓ Saved' : 'Save'}</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView style={ss.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 18, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">

        {/* Avatar hero */}
        <View style={profSt.hero}>
          <TouchableOpacity style={profSt.coverCard} activeOpacity={0.85} onPress={() => pickProfileImage('cover')}>
            {coverImageUrl ? <Image source={{ uri: coverImageUrl }} style={profSt.coverImage} /> : null}
            <View style={profSt.coverOverlay} />
            <View style={profSt.coverBadge}>
              {uploadingIdx === 'cover'
                ? <ActivityIndicator color={C.white} size="small" />
                : <Text style={profSt.coverBadgeText}>{coverImageUrl ? 'Edit Cover' : 'Add Cover'}</Text>}
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={profSt.avatarWrap} activeOpacity={0.85} onPress={() => pickProfileImage('avatar')}>
            <View style={profSt.avatar}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={profSt.avatarImage} />
              ) : (
                <Text style={profSt.avatarText}>{(name[0] ?? 'C').toUpperCase()}</Text>
              )}
            </View>
            <View style={profSt.avatarEditBadge}>
              {uploadingIdx === 'avatar'
                ? <ActivityIndicator color={C.white} size="small" />
                : <Text style={profSt.avatarEditBadgeText}>📷</Text>}
            </View>
          </TouchableOpacity>
          <Text style={profSt.heroHint}>Tap the circle to add chef photo. Tap the top banner to add a background image.</Text>
          <View style={profSt.statsRow}>
            <View style={profSt.statItem}>
              <Text style={profSt.statNum}>{user?.rating ?? 0}★</Text>
              <Text style={profSt.statLabel}>Rating</Text>
            </View>
            <View style={profSt.statDivider} />
            <View style={profSt.statItem}>
              <Text style={profSt.statNum}>{user?.totalOrders ?? 0}</Text>
              <Text style={profSt.statLabel}>Orders</Text>
            </View>
            <View style={profSt.statDivider} />
            <View style={profSt.statItem}>
              <Text style={profSt.statNum}>{user?.ratingCount ?? 0}</Text>
              <Text style={profSt.statLabel}>Reviews</Text>
            </View>
          </View>
        </View>

        {/* Availability */}
        <View style={profSt.availRow}>
          <View style={profSt.availLeft}>
            <View style={[profSt.dot, { backgroundColor: isAvailable ? C.mint : C.warmGray }]} />
            <View>
              <Text style={profSt.availTitle}>{isAvailable ? 'Taking Orders' : 'Unavailable'}</Text>
              <Text style={profSt.availSub}>{isAvailable ? 'You are visible to buyers' : 'Hidden from buyers'}</Text>
            </View>
          </View>
          <Switch value={isAvailable} onValueChange={onToggleAvailability} trackColor={{ false: C.border, true: C.mint }} thumbColor={C.white} />
        </View>

        <TouchableOpacity style={profSt.locationCard} activeOpacity={0.8} onPress={onOpenLocationSettings}>
          <View style={profSt.locationCardCopy}>
            <Text style={profSt.locationCardTitle}>Service Location</Text>
            <Text style={profSt.locationCardValue}>{locationLabel}</Text>
            <Text style={profSt.locationCardSub}>{hasGpsLocation ? `GPS locked. Requests within ${geoRadius} km are shown.` : 'GPS not set. Using manual area only.'}</Text>
          </View>
          <Text style={profSt.locationCardAction}>Edit</Text>
        </TouchableOpacity>

        {/* Editable fields */}
        {[
          { label: 'Full Name',       val: name,  set: setName,  ph: 'Your name' },
          { label: 'City / Area',     val: city,  set: setCity,  ph: 'Your city or area' },
          { label: 'Cooking Style',   val: style, set: setStyle, ph: 'e.g. Bengali, Mughlai, Continental' },
        ].map((f) => (
          <View key={f.label} style={profSt.field}>
            <Text style={ss.fieldLabel}>{f.label}</Text>
            <TextInput style={profSt.input} value={f.val} onChangeText={f.set} placeholder={f.ph} placeholderTextColor="#BDB5AB" />
          </View>
        ))}

        <View style={profSt.field}>
          <Text style={ss.fieldLabel}>Bio</Text>
          <TextInput
            style={[profSt.input, { minHeight: 90 }]}
            value={bio}
            onChangeText={setBio}
            multiline
            textAlignVertical="top"
            placeholder="Tell buyers about your cooking..."
            placeholderTextColor="#BDB5AB"
          />
        </View>

        {/* Kitchen Images */}
        <View style={profSt.kitchenSection}>
          <Text style={ss.fieldLabel}>KITCHEN PHOTOS</Text>
          <Text style={profSt.kitchenHint}>Add up to 5 photos of your kitchen or cooking space.</Text>
          <View style={profSt.kitchenGrid}>
            {Array.from({ length: 5 }).map((_, idx) => {
              const url = kitchenImages[idx];
              const isUploading = uploadingIdx === idx;
              return (
                <View key={idx} style={profSt.kitchenSlot}>
                  {url ? (
                    <>
                      <Image source={{ uri: url }} style={profSt.kitchenImg} />
                      <TouchableOpacity style={profSt.kitchenRemoveBtn} onPress={() => removeKitchenImage(idx)} activeOpacity={0.8}>
                        <Text style={profSt.kitchenRemoveText}>✕</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <TouchableOpacity style={profSt.kitchenAddBtn} onPress={() => pickKitchenImage(idx)} activeOpacity={0.75} disabled={isUploading}>
                      {isUploading
                        ? <ActivityIndicator color={C.mint} size="small" />
                        : <Text style={profSt.kitchenAddIcon}>+</Text>}
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>
        </View>

        <View style={profSt.specialitySection}>
          <View style={profSt.specialityHeader}>
            <View style={profSt.specialityHeaderCopy}>
              <Text style={ss.fieldLabel}>SPECIALITY DISHES</Text>
              <Text style={profSt.specialityHint}>New dishes from your today board are added here automatically. Only unique dishes are kept.</Text>
            </View>
            <TouchableOpacity style={profSt.specialityAddBtn} activeOpacity={0.8} onPress={onOpenTodayBoard}>
              <Text style={profSt.specialityAddBtnText}>Add</Text>
            </TouchableOpacity>
          </View>

          {getSpecialityDishList(user?.specialityDishes).length === 0 ? (
            <View style={profSt.specialityEmpty}>
              <Text style={profSt.specialityEmptyTitle}>No speciality dishes yet</Text>
              <Text style={profSt.specialityEmptySub}>Float a dish in "Show what you are cooking today" with a food photo and it will appear here.</Text>
            </View>
          ) : (
            getSpecialityDishList(user?.specialityDishes).map((dish) => (
              <View key={dish.dishName} style={profSt.specialityCard}>
                <Image source={{ uri: dish.imageUrl }} style={profSt.specialityImage} />
                <View style={profSt.specialityBody}>
                  <Text style={profSt.specialityName} numberOfLines={1}>{dish.dishName}</Text>
                  {dish.ratingCount > 0 ? (
                    <Text style={profSt.specialityReviewMeta}>⭐ {dish.ratingAverage.toFixed(1)} · {dish.ratingCount} review{dish.ratingCount > 1 ? 's' : ''}</Text>
                  ) : null}
                  <Text style={profSt.specialityDescription} numberOfLines={2}>{dish.description}</Text>
                  <Text style={profSt.specialityUnits}>{dish.unitsSold} unit{dish.unitsSold === 1 ? '' : 's'} sold</Text>
                  {dish.recentReviews[0]?.comment ? (
                    <Text style={profSt.specialityReviewQuote} numberOfLines={1}>"{dish.recentReviews[0].comment}"</Text>
                  ) : null}
                  <Text style={profSt.specialityPrice}>Last sold price ₹{dish.lastSoldPrice}</Text>
                </View>
              </View>
            ))
          )}
        </View>

        <Text style={profSt.phone}>📱 {user?.phone}</Text>

        <TouchableOpacity
          style={profSt.logoutBtn}
          activeOpacity={0.75}
          onPress={() =>
            Linking.openURL(`${API_BASE.replace(/\/api$/, '')}/privacy-policy`).catch(() =>
              Alert.alert('Link unavailable', 'Could not open the privacy policy page.'),
            )
          }
        >
          <Text style={profSt.logoutText}>Privacy Policy & Data Safety</Text>
        </TouchableOpacity>

        {/* Logout */}
        <TouchableOpacity
          style={profSt.logoutBtn}
          activeOpacity={0.75}
          onPress={() =>
            Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign Out', style: 'destructive', onPress: onLogout },
            ])
          }
        >
          <Text style={profSt.logoutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  TIMER EXPIRED MODAL
// ─────────────────────────────────────────────────────────────────────────
function TimerExpiredModal({
  dish,
  onExtend,
  onMarkReady,
  extending,
}: {
  dish: CookingDishItem;
  onExtend: (mins: number) => void;
  onMarkReady: () => void;
  extending: boolean;
}) {
  const scaleAnim = useRef(new Animated.Value(0.88)).current;
  const opAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: 1, tension: 80, friction: 8, useNativeDriver: true }),
      Animated.timing(opAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, []);

  const EXTEND_OPTIONS = [5, 10, 15, 30];

  return (
    <Modal transparent animationType="none" statusBarTranslucent>
      <Animated.View style={[mSt.backdrop, { opacity: opAnim }]}>
        <Animated.View style={[mSt.sheet, { transform: [{ scale: scaleAnim }] }]}>
          <View style={mSt.timerIconWrap}>
            <Text style={mSt.timerIcon}>⏰</Text>
          </View>
          <Text style={mSt.sheetTitle}>Time's up!</Text>
          <Text style={mSt.sheetDish} numberOfLines={1}>{dish.dishName}</Text>
          <Text style={mSt.sheetSub}>Is the dish ready, or do you need more time?</Text>

          <Text style={mSt.extendLabel}>EXTEND TIME</Text>
          <View style={mSt.extendRow}>
            {EXTEND_OPTIONS.map((mins) => (
              <TouchableOpacity
                key={mins}
                style={mSt.extendBtn}
                onPress={() => onExtend(mins)}
                activeOpacity={0.75}
                disabled={extending}
              >
                {extending ? (
                  <ActivityIndicator size="small" color={C.mint} />
                ) : (
                  <>
                    <Text style={mSt.extendBtnMins}>+{mins}</Text>
                    <Text style={mSt.extendBtnLabel}>min</Text>
                  </>
                )}
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={mSt.readyBtn} onPress={onMarkReady} activeOpacity={0.85}>
            <Text style={mSt.readyBtnText}>Dish is Ready  →  Go Live</Text>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  GO LIVE MODAL
// ─────────────────────────────────────────────────────────────────────────
function GoLiveModal({
  dish,
  onClose,
  onGoLive,
  uploading,
}: {
  dish: CookingDishItem;
  onClose: () => void;
  onGoLive: (base64: string) => void;
  uploading: boolean;
}) {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const scaleAnim = useRef(new Animated.Value(0.88)).current;
  const opAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: 1, tension: 80, friction: 8, useNativeDriver: true }),
      Animated.timing(opAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, []);

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera permission required', 'Please allow camera access to take a photo of your dish.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 1,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0]) {
      const compressed = await compressToTargetKB(result.assets[0].uri, 30);
      setPhotoUri(result.assets[0].uri);
      setPhotoBase64(compressed.base64);
    }
  };

  const pickFromGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Gallery permission required');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!result.canceled && result.assets[0]) {
      const compressed = await compressToTargetKB(result.assets[0].uri, 30);
      setPhotoUri(result.assets[0].uri);
      setPhotoBase64(compressed.base64);
    }
  };

  return (
    <Modal transparent animationType="none" statusBarTranslucent>
      <Animated.View style={[mSt.backdrop, { opacity: opAnim }]}>
        <Animated.View style={[mSt.sheet, { transform: [{ scale: scaleAnim }] }]}>
          {/* Header */}
          <View style={mSt.goLiveHeader}>
            <View style={mSt.goLiveHeaderBlob} />
            <Text style={mSt.goLiveEyebrow}>GOING LIVE</Text>
            <Text style={mSt.goLiveTitle}>Take a photo{'\n'}of your dish</Text>
            <Text style={mSt.goLiveSub} numberOfLines={1}>{dish.dishName}</Text>
          </View>

          {/* Photo area */}
          {photoUri ? (
            <View style={mSt.photoPreviewWrap}>
              <Image source={{ uri: photoUri }} style={mSt.photoPreview} />
              <View style={mSt.photoPreviewBadge}>
                <Text style={mSt.photoPreviewBadgeText}>✓ Photo ready</Text>
              </View>
            </View>
          ) : (
            <View style={mSt.photoPlaceholder}>
              <Text style={mSt.photoPlaceholderEmoji}>{dish.emoji}</Text>
              <Text style={mSt.photoPlaceholderText}>No photo yet</Text>
            </View>
          )}

          {/* Actions */}
          <View style={mSt.photoActions}>
            <TouchableOpacity style={mSt.cameraBtn} onPress={takePhoto} activeOpacity={0.8}>
              <Text style={mSt.cameraBtnIcon}>📷</Text>
              <Text style={mSt.cameraBtnText}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={mSt.cameraBtn} onPress={pickFromGallery} activeOpacity={0.8}>
              <Text style={mSt.cameraBtnIcon}>🖼</Text>
              <Text style={mSt.cameraBtnText}>Gallery</Text>
            </TouchableOpacity>
          </View>

          {/* Go Live CTA */}
          <TouchableOpacity
            style={[mSt.goLiveBtn, (!photoBase64 || uploading) && mSt.goLiveBtnDisabled]}
            onPress={() => photoBase64 && onGoLive(photoBase64)}
            activeOpacity={0.85}
            disabled={!photoBase64 || uploading}
          >
            {uploading ? (
              <ActivityIndicator color={C.white} />
            ) : (
              <Text style={mSt.goLiveBtnText}>🟢  Go Live Now</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={mSt.cancelBtn} onPress={onClose} activeOpacity={0.7}>
            <Text style={mSt.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  TODAY MENU HELPERS
// ─────────────────────────────────────────────────────────────────────────
function SteamDot({ delay }: { delay: number }) {
  const y = useRef(new Animated.Value(0)).current;
  const op = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(y, { toValue: -16, duration: 1100, useNativeDriver: true }),
          Animated.sequence([
            Animated.timing(op, { toValue: 0.8, duration: 400, useNativeDriver: true }),
            Animated.timing(op, { toValue: 0, duration: 700, useNativeDriver: true }),
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
  return (
    <Animated.View style={[todaySt.steamDot, { opacity: op, transform: [{ translateY: y }] }]} />
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  REUSABLE CARD COMPONENTS
// ─────────────────────────────────────────────────────────────────────────
function TodayMenuScreen({
  dishes,
  specialityDishes,
  onBack,
  onSaveDish,
  onRemoveDish,
  onExtendTimer,
  onGoLive,
}: {
  dishes: TodayDish[];
  specialityDishes: SpecialityDish[];
  onBack: () => void;
  onSaveDish: (dish: CreateCookingDishPayload) => Promise<void>;
  onRemoveDish: (id: string) => Promise<void>;
  onExtendTimer: (id: string, minutes: number) => Promise<void>;
  onGoLive: (id: string, base64: string) => Promise<void>;
}) {
  const [dishName, setDishName] = useState('');
  const [dishEmoji, setDishEmoji] = useState('🍽');
  const [cuisine, setCuisine] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [pricePerPlate, setPricePerPlate] = useState('180');
  const [plates, setPlates] = useState(1);
  const [portionType, setPortionType] = useState<'quantity' | 'pieces'>('quantity');
  const [portionValue, setPortionValue] = useState('100');
  const [portionUnit, setPortionUnit] = useState('gms');
  const [readyInMinutes, setReadyInMinutes] = useState(30);
  const [notes, setNotes] = useState('');
  const [showCustomCuisine, setShowCustomCuisine] = useState(false);
  const [customCuisine, setCustomCuisine] = useState('');
  const [showCustomDishTag, setShowCustomDishTag] = useState(false);
  const [customDishTag, setCustomDishTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [showSkillsForm, setShowSkillsForm] = useState(false);
  const [showDishSuggestions, setShowDishSuggestions] = useState(false);
  const [, setBoardTick] = useState(0);

  // Timer expiry state
  const [expiredDish, setExpiredDish] = useState<TodayDish | null>(null);
  const [goLiveDish, setGoLiveDish] = useState<TodayDish | null>(null);
  const [extending, setExtending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const alreadyAlerted = useRef(new Set<string>());
  const dishesRef = useRef(dishes);
  useEffect(() => { dishesRef.current = dishes; }, [dishes]);

  // Single interval: tick display + detect newly-expired timers
  useEffect(() => {
    const id = setInterval(() => {
      setBoardTick((t) => t + 1);
      for (const dish of dishesRef.current) {
        if (dish.imageUrl) continue; // already live, skip
        const remaining = Math.floor((new Date(dish.readyAt).getTime() - Date.now()) / 1000);
        if (remaining <= 0 && !alreadyAlerted.current.has(dish.id)) {
          alreadyAlerted.current.add(dish.id);
          setExpiredDish(dish);
          break; // one at a time
        }
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const boardTimeLeft = (readyAt: string) => {
    const remaining = Math.floor((new Date(readyAt).getTime() - Date.now()) / 1000);
    if (remaining <= 0) return null;
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    return mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;
  };

  const dishQuery = dishName.trim().toLowerCase();
  const matchingSpecialityDishes = dishQuery.length === 0
    ? specialityDishes.map((item) => normaliseSpecialityDish(item)).slice(0, 6)
    : specialityDishes
      .map((item) => normaliseSpecialityDish(item))
      .filter((item) => item.dishName.toLowerCase().includes(dishQuery))
      .slice(0, 6);

  const applySpecialityDish = (dish: SpecialityDish) => {
    const preset = normaliseSpecialityDish(dish);
    setDishName(preset.dishName);
    setDishEmoji(preset.emoji);
    setCuisine(preset.cuisine);
    setSelectedTags(preset.tags);
    setPricePerPlate(String(preset.lastSoldPrice));
    setPortionType(preset.portionType);
    setPortionValue(String(preset.portionValue));
    setPortionUnit(preset.portionUnit);
    setReadyInMinutes(preset.readyInMinutes);
    setNotes(preset.notes);
    if (CUISINE_TAGS.includes(preset.cuisine as typeof CUISINE_TAGS[number])) {
      setShowCustomCuisine(false);
      setCustomCuisine('');
    } else {
      setShowCustomCuisine(true);
      setCustomCuisine(preset.cuisine);
    }
    const customTags = preset.tags.filter((tag) => !DISH_PREFERENCE_TAGS.includes(tag as typeof DISH_PREFERENCE_TAGS[number]));
    if (customTags.length > 0) {
      setShowCustomDishTag(true);
      setCustomDishTag(customTags[customTags.length - 1]);
    } else {
      setShowCustomDishTag(false);
      setShowDishSuggestions(false);
      setCustomDishTag('');
    }
    setShowDishSuggestions(false);
  };

  const saveDish = async () => {
    const parsedPrice = parseInt(pricePerPlate, 10);
    const parsedPortionValue = parseInt(portionValue, 10);
    if (!dishName.trim() || !cuisine.trim() || !parsedPrice || parsedPrice <= 0 || !parsedPortionValue || parsedPortionValue <= 0 || !portionUnit.trim()) {
      Alert.alert('Missing details', 'Add dish name, cuisine, price per plate, plates, and per-plate quantity before saving.');
      return;
    }

    setSaving(true);
    try {
      await onSaveDish({
      dishName: dishName.trim(),
      emoji: dishEmoji,
      cuisine: cuisine.trim(),
      tags: selectedTags,
      pricePerPlate: parsedPrice,
      plates,
      portionType,
      portionValue: parsedPortionValue,
      portionUnit: portionUnit.trim(),
      readyInMinutes,
      notes: notes.trim(),
      });
    setDishName('');
    setDishEmoji('🍽');
    setCuisine('');
    setSelectedTags([]);
    setPricePerPlate('180');
    setPlates(1);
    setPortionType('quantity');
    setPortionValue('100');
    setPortionUnit('gms');
    setReadyInMinutes(30);
    setNotes('');
    setCustomCuisine('');
    setShowCustomCuisine(false);
    setCustomDishTag('');
      setShowCustomDishTag(false);
      Alert.alert('Saved', 'This dish is now listed in your today board.');
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not save this dish.');
    } finally {
      setSaving(false);
    }
  };

  const handleExtend = async (mins: number) => {
    if (!expiredDish) return;
    setExtending(true);
    try {
      await onExtendTimer(expiredDish.id, mins);
      alreadyAlerted.current.delete(expiredDish.id); // allow re-alert when new timer ends
      setExpiredDish(null);
    } catch {
      Alert.alert('Error', 'Could not extend timer.');
    } finally {
      setExtending(false);
    }
  };

  const handleGoLive = async (base64: string) => {
    if (!goLiveDish) return;
    setUploading(true);
    try {
      await onGoLive(goLiveDish.id, base64);
      setGoLiveDish(null);
      setExpiredDish(null);
    } catch {
      Alert.alert('Error', 'Could not go live. Try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      {/* Top Bar */}
      <View style={todaySt.topBar}>
        <TouchableOpacity style={todaySt.backBtn} onPress={onBack} activeOpacity={0.75}>
          <Text style={todaySt.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={todaySt.topTitle}>Cooking Today</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={ss.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={todaySt.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Today Board listed dishes */}
        <View style={todaySt.sectionHeader}>
          <Text style={todaySt.sectionTitle}>Today Board</Text>
          <View style={todaySt.sectionBadge}>
            <Text style={todaySt.sectionBadgeText}>{dishes.length} listed</Text>
          </View>
        </View>

        {dishes.length === 0 ? (
          <View style={todaySt.emptyCard}>
            <Text style={todaySt.emptyEmoji}>🍲</Text>
            <Text style={todaySt.emptyTitle}>No dishes added yet</Text>
            <Text style={todaySt.emptySub}>Your dishes for today will appear here after you save them.</Text>
          </View>
        ) : (
          dishes.map((dish) => (
            <View key={dish.id} style={todaySt.dishCard}>
              <View style={todaySt.dishCardLeft}>
                {dish.imageUrl ? (
                  <Image source={{ uri: dish.imageUrl }} style={todaySt.dishCardPhoto} />
                ) : (
                  <Text style={todaySt.dishCardEmoji}>{dish.emoji}</Text>
                )}
                <View style={[todaySt.liveBadge, dish.imageUrl && todaySt.liveBadgeLive]}>
                  <View style={[todaySt.liveDot, dish.imageUrl && todaySt.liveDotLive]} />
                  <Text style={[todaySt.liveText, dish.imageUrl && todaySt.liveTextLive]}>
                    {dish.imageUrl ? 'LIVE' : 'live'}
                  </Text>
                </View>
              </View>
              <View style={todaySt.dishCardRight}>
                <View style={todaySt.dishCardTopRow}>
                  <Text style={todaySt.dishCardName} numberOfLines={1}>{dish.dishName}</Text>
                  <View style={[todaySt.dishStatusPill, boardTimeLeft(dish.readyAt) ? todaySt.dishStatusCooking : todaySt.dishStatusReady]}>
                    <Text style={todaySt.dishStatusText}>{boardTimeLeft(dish.readyAt) ? `🍳 ${boardTimeLeft(dish.readyAt)}` : '✅ Ready'}</Text>
                  </View>
                </View>
                <View style={todaySt.dishCardMeta}>
                  <View style={todaySt.tagPill}>
                    <Text style={todaySt.tagPillText}>{dish.cuisine}</Text>
                  </View>
                  <Text style={todaySt.dishCardSub}> · {dish.bookedPlates ?? 0}/{dish.plates + (dish.bookedPlates ?? 0)} plates booked</Text>
                </View>
                <Text style={todaySt.dishCardDetail}>₹{dish.pricePerPlate}/plate · {dish.portionValue} {dish.portionUnit} per plate</Text>
                {dish.notes?.trim() ? <Text style={todaySt.dishCardNote} numberOfLines={1}>{dish.notes}</Text> : null}
                <TouchableOpacity onPress={() => onRemoveDish(dish.id)} activeOpacity={0.75}>
                  <Text style={todaySt.removeText}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}

        {/* Culinary Skills Banner */}
        <TouchableOpacity style={todaySt.culinaryBanner} activeOpacity={0.85} onPress={() => setShowSkillsForm((curr) => !curr)}>
          <View style={todaySt.culinaryBannerBlob} />
          <View style={todaySt.culinaryBannerBlobSmall} />
          <View style={{ flex: 1 }}>
            <Text style={todaySt.bannerTag}>CULINARY SKILLS</Text>
            <Text style={todaySt.bannerTitle}>{'Show what you are\ncooking today.'}</Text>
            <Text style={todaySt.bannerSub}>Tap to {showSkillsForm ? 'hide' : 'open'} the add-dish form for today.</Text>
          </View>
          <View style={todaySt.bannerSteam}>
            <View style={todaySt.bannerSteamDots}>
              <SteamDot delay={0} />
              <SteamDot delay={280} />
              <SteamDot delay={560} />
            </View>
            <View style={todaySt.bannerPot}>
              <Text style={todaySt.bannerPotEmoji}>🍲</Text>
            </View>
          </View>
        </TouchableOpacity>

        {/* Add a Dish Form */}
        {showSkillsForm ? (
          <View style={todaySt.formCard}>
            <View style={todaySt.formHeader}>
              <Text style={todaySt.formTitle}>Add a dish for today</Text>
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>DISH NAME</Text>
              <TextInput
                style={todaySt.textInput}
                value={dishName}
                onChangeText={(value) => {
                  setDishName(value);
                  setShowDishSuggestions(true);
                }}
                onFocus={() => setShowDishSuggestions(true)}
                placeholder="e.g. Kolkata Chicken Biryani"
                placeholderTextColor={C.warmGray}
              />
              {showDishSuggestions && dishQuery.length > 0 && matchingSpecialityDishes.length > 0 ? (
                <View style={todaySt.suggestionMenu}>
                  {matchingSpecialityDishes.map((item) => (
                    <TouchableOpacity
                      key={item.dishName}
                      style={todaySt.suggestionItem}
                      activeOpacity={0.75}
                      onPress={() => applySpecialityDish(item)}
                    >
                      <View style={todaySt.suggestionCopy}>
                        <Text style={todaySt.suggestionTitle}>{item.dishName}</Text>
                        <Text style={todaySt.suggestionMeta} numberOfLines={1}>
                          {item.cuisine} · ₹{item.lastSoldPrice}/plate · {item.portionValue} {item.portionUnit}
                        </Text>
                      </View>
                      <Text style={todaySt.suggestionAction}>Use</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>FOOD PIC EMOJI</Text>
              <View style={todaySt.emojiGrid}>
                {DISH_EMOJI_OPTIONS.map((item) => {
                  const active = dishEmoji === item.emoji;
                  return (
                    <TouchableOpacity
                      key={`${item.label}-${item.emoji}`}
                      style={[todaySt.emojiChip, active && todaySt.emojiChipActive]}
                      onPress={() => setDishEmoji(item.emoji)}
                      activeOpacity={0.75}
                    >
                      <Text style={todaySt.emojiIcon}>{item.emoji}</Text>
                      <Text style={[todaySt.emojiLabel, active && todaySt.emojiLabelActive]}>{item.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={todaySt.emojiHintBox}>
                <Text style={todaySt.emojiHint}>Use an emoji for now. Once the dish is ready, add a real food photo to make your today board feel fresh and irresistible.</Text>
              </View>
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>CUISINE / SKILL</Text>
              <View style={todaySt.tagsWrap}>
                {CUISINE_TAGS.map((tag) => (
                  <TouchableOpacity
                    key={tag}
                    style={[todaySt.cuisineTag, cuisine === tag && todaySt.cuisineTagSelected]}
                    onPress={() => setCuisine(tag)}
                    activeOpacity={0.75}
                  >
                    <Text style={[todaySt.cuisineTagText, cuisine === tag && todaySt.cuisineTagTextSelected]}>{tag}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[todaySt.addTagBtn, showCustomCuisine && todaySt.addTagBtnActive]}
                  onPress={() => setShowCustomCuisine((curr) => !curr)}
                  activeOpacity={0.75}
                >
                  <Text style={todaySt.addTagBtnText}>+ Add New Tag</Text>
                </TouchableOpacity>
              </View>
              {showCustomCuisine ? (
                <View style={todaySt.customTagBox}>
                  <TextInput
                    style={[todaySt.textInput, { flex: 1 }]}
                    value={customCuisine}
                    onChangeText={setCustomCuisine}
                    placeholder="e.g. Lebanese, Thai, Fusion"
                    placeholderTextColor={C.warmGray}
                  />
                  <TouchableOpacity
                    style={todaySt.customTagSave}
                    activeOpacity={0.8}
                    onPress={() => {
                      const trimmed = customCuisine.trim();
                      if (!trimmed) return;
                      setCuisine(trimmed);
                      setCustomCuisine(trimmed);
                      setShowCustomCuisine(false);
                    }}
                  >
                    <Text style={todaySt.customTagSaveText}>Use</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>DISH TAGS</Text>
              <View style={todaySt.tagsWrap}>
                {DISH_PREFERENCE_TAGS.map((tag) => {
                  const active = selectedTags.includes(tag);
                  return (
                    <TouchableOpacity
                      key={tag}
                      style={[todaySt.cuisineTag, active && todaySt.cuisineTagSelected]}
                      onPress={() => setSelectedTags((curr) => active ? curr.filter((item) => item !== tag) : [...curr, tag])}
                      activeOpacity={0.75}
                    >
                      <Text style={[todaySt.cuisineTagText, active && todaySt.cuisineTagTextSelected]}>{tag}</Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  style={[todaySt.addTagBtn, showCustomDishTag && todaySt.addTagBtnActive]}
                  onPress={() => setShowCustomDishTag((curr) => !curr)}
                  activeOpacity={0.75}
                >
                  <Text style={todaySt.addTagBtnText}>+ Add New Tag</Text>
                </TouchableOpacity>
              </View>
              {showCustomDishTag ? (
                <View style={todaySt.customTagBox}>
                  <TextInput
                    style={[todaySt.textInput, { flex: 1 }]}
                    value={customDishTag}
                    onChangeText={setCustomDishTag}
                    placeholder="e.g. Extra Gravy, Kids Friendly"
                    placeholderTextColor={C.warmGray}
                  />
                  <TouchableOpacity
                    style={todaySt.customTagSave}
                    activeOpacity={0.8}
                    onPress={() => {
                      const trimmed = customDishTag.trim();
                      if (!trimmed) return;
                      setSelectedTags((curr) => curr.includes(trimmed) ? curr : [...curr, trimmed]);
                      setCustomDishTag('');
                      setShowCustomDishTag(false);
                    }}
                  >
                    <Text style={todaySt.customTagSaveText}>Use</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>

            <View style={todaySt.divider} />

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>PRICE PER PLATE</Text>
              <View style={todaySt.priceRow}>
                <Text style={todaySt.rupeeSign}>₹</Text>
                <TextInput
                  style={todaySt.priceInput}
                  value={pricePerPlate}
                  onChangeText={setPricePerPlate}
                  keyboardType="numeric"
                  placeholder="180"
                  placeholderTextColor={C.warmGray}
                />
                <Text style={todaySt.perPlate}>per plate</Text>
              </View>
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>AVAILABLE PORTIONS</Text>
              <View style={todaySt.portionCard}>
                <View style={todaySt.stepperRow}>
                  <Text style={todaySt.stepperLabel}>Number of plates</Text>
                  <View style={todaySt.stepperControls}>
                    <TouchableOpacity style={todaySt.stepBtn} onPress={() => setPlates((curr) => Math.max(1, curr - 1))} activeOpacity={0.75}>
                      <Text style={todaySt.stepBtnText}>−</Text>
                    </TouchableOpacity>
                    <Text style={todaySt.stepperValue}>{plates}</Text>
                    <TouchableOpacity style={todaySt.stepBtn} onPress={() => setPlates((curr) => curr + 1)} activeOpacity={0.75}>
                      <Text style={todaySt.stepBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>PER PLATE MEASURE</Text>
              <View style={todaySt.segmented}>
                {(['quantity', 'pieces'] as const).map((type) => (
                  <TouchableOpacity
                    key={type}
                    style={[todaySt.segOption, portionType === type && todaySt.segOptionSelected]}
                    onPress={() => {
                      setPortionType(type);
                      setPortionUnit(type === 'pieces' ? 'pieces' : 'gms');
                    }}
                    activeOpacity={0.75}
                  >
                    <Text style={[todaySt.segOptionText, portionType === type && todaySt.segOptionTextSelected]}>
                      {type === 'pieces' ? 'Pieces' : 'Quantity'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={todaySt.measureRow}>
                <TextInput
                  style={[todaySt.textInput, { flex: 1, marginRight: 10 }]}
                  value={portionValue}
                  onChangeText={setPortionValue}
                  keyboardType="numeric"
                  placeholder={portionType === 'pieces' ? 'e.g. 2' : 'e.g. 100'}
                  placeholderTextColor={C.warmGray}
                />
                <TextInput
                  style={[todaySt.textInput, { flex: 1 }]}
                  value={portionUnit}
                  onChangeText={setPortionUnit}
                  placeholder={portionType === 'pieces' ? 'pieces' : 'gms'}
                  placeholderTextColor={C.warmGray}
                  editable={portionType === 'quantity'}
                />
              </View>
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>READY BY</Text>
              <View style={todaySt.sliderCard}>
                <View style={todaySt.sliderTopRow}>
                  <Text style={todaySt.sliderTitle}>Time to prepare</Text>
                  <Text style={todaySt.sliderValue}>{formatReadyTime(readyInMinutes)}</Text>
                </View>
                <Slider
                  style={todaySt.readySlider}
                  minimumValue={0}
                  maximumValue={120}
                  step={5}
                  minimumTrackTintColor={C.mint}
                  maximumTrackTintColor={C.border}
                  thumbTintColor={C.mint}
                  value={readyInMinutes}
                  onValueChange={setReadyInMinutes}
                />
                <View style={todaySt.sliderLabels}>
                  <Text style={todaySt.sliderTickLabel}>0 mins</Text>
                  <Text style={todaySt.sliderTickLabel}>30 mins</Text>
                  <Text style={todaySt.sliderTickLabel}>1 hr</Text>
                  <Text style={todaySt.sliderTickLabel}>2 hrs</Text>
                </View>
              </View>
            </View>

            <View style={todaySt.formSection}>
              <Text style={todaySt.fieldLabel}>NOTES</Text>
              <TextInput
                style={[todaySt.textInput, todaySt.notesInput]}
                value={notes}
                onChangeText={setNotes}
                multiline
                textAlignVertical="top"
                placeholder="Optional details: spice level, delivery, fresh batch timing..."
                placeholderTextColor={C.warmGray}
              />
            </View>

            <TouchableOpacity style={todaySt.ctaBtn} onPress={saveDish} activeOpacity={0.85} disabled={saving}>
              {saving ? <ActivityIndicator color={C.white} /> : <Text style={todaySt.ctaBtnText}>Add To Today Board</Text>}
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Timer expired modal */}
      {expiredDish && !goLiveDish ? (
        <TimerExpiredModal
          dish={expiredDish}
          onExtend={handleExtend}
          onMarkReady={() => { setGoLiveDish(expiredDish); }}
          extending={extending}
        />
      ) : null}

      {/* Go live modal */}
      {goLiveDish ? (
        <GoLiveModal
          dish={goLiveDish}
          onClose={() => { setGoLiveDish(null); setExpiredDish(null); }}
          onGoLive={handleGoLive}
          uploading={uploading}
        />
      ) : null}
    </>
  );
}

const CATEGORY_EMOJI: Record<string, string> = {
  chicken: '🍗', mutton: '🥩', biryani: '🍚', dal: '🥘',
  dessert: '🍰', custom: '🍽', noodles: '🍜', veg: '🥬',
};

// ─────────────────────────────────────────────────────────────────────────
//  DISH OFFER CARD
// ─────────────────────────────────────────────────────────────────────────
function DishOfferCard({
  offer, onAccept, onReject, onCounter,
}: {
  offer: DishOffer;
  onAccept: () => void;
  onReject: () => void;
  onCounter: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isExactPrice = !!offer.exactPriceRequested;

  const wrap = (fn: () => void) => async () => {
    setBusy(true);
    try { fn(); } finally { setBusy(false); }
  };

  const STATUS_COLOR: Record<string, string> = {
    PENDING: C.turmeric,
    COUNTERED: C.spice,
    HOLD: '#4F6CF5',
    PAID: C.mint,
    REJECTED: C.warmGray,
    EXPIRED: C.red,
  };
  const statusColor = STATUS_COLOR[offer.status] ?? C.warmGray;

  return (
    <View style={offerSt.card}>
      {/* Header row */}
      <View style={offerSt.cardHeader}>
        <View style={offerSt.emojiWrap}>
          <Text style={offerSt.emoji}>{offer.dishEmoji}</Text>
        </View>
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={offerSt.dishName}>{offer.dishName}</Text>
          <Text style={offerSt.buyerLine}>{offer.buyerName}</Text>
          {isExactPrice ? (
            <View style={offerSt.exactPricePill}>
              <Text style={offerSt.exactPriceText}>⚡ Exact Price • No Negotiation</Text>
            </View>
          ) : null}
        </View>
        <View style={[offerSt.statusPill, { backgroundColor: statusColor + '22' }]}>
          <Text style={[offerSt.statusText, { color: statusColor }]}>{offer.status}</Text>
        </View>
      </View>

      {/* Price + plates row */}
      <View style={offerSt.infoRow}>
        <View style={offerSt.infoChip}>
          <Text style={offerSt.infoLabel}>OFFER PRICE</Text>
          <Text style={offerSt.infoValue}>{'\u20B9'}{offer.offerPrice}/plate</Text>
        </View>
        <View style={offerSt.infoChip}>
          <Text style={offerSt.infoLabel}>PLATES</Text>
          <Text style={offerSt.infoValue}>{offer.plates}</Text>
        </View>
        <View style={offerSt.infoChip}>
          <Text style={offerSt.infoLabel}>TOTAL</Text>
          <Text style={offerSt.infoValue}>{'\u20B9'}{offer.offerPrice * offer.plates}</Text>
        </View>
      </View>

      {/* Counter price — shown on COUNTERED (awaiting buyer) and PENDING (buyer re-countered, ceiling preserved) */}
      {offer.counterPrice && !isExactPrice ? (
        <View style={[offerSt.counterBanner, offer.status === 'PENDING' && offerSt.counterBannerMuted]}>
          <Text style={[offerSt.counterBannerText, offer.status === 'PENDING' && offerSt.counterBannerTextMuted]}>
            {offer.status === 'PENDING' ? 'Your ceiling: ' : 'Your counter: '}
            {'\u20B9'}{offer.counterPrice}/plate
            {offer.counterNote && offer.status === 'COUNTERED' ? `  "${offer.counterNote}"` : ''}
          </Text>
        </View>
      ) : null}

      {/* Buyer message */}
      {offer.message ? (
        <Text style={offerSt.message}>"{offer.message}"</Text>
      ) : null}

      {/* Actions — only for PENDING */}
      {offer.status === 'PENDING' ? (
        <View style={offerSt.actions}>
          <TouchableOpacity
            style={[offerSt.actionBtn, offerSt.actionReject]}
            disabled={busy}
            onPress={wrap(onReject)}
          >
            <Text style={offerSt.actionRejectText}>Reject</Text>
          </TouchableOpacity>
          {!isExactPrice ? (
            <TouchableOpacity
              style={[offerSt.actionBtn, offerSt.actionCounter]}
              disabled={busy}
              onPress={onCounter}
            >
              <Text style={offerSt.actionCounterText}>Counter</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[offerSt.actionBtn, offerSt.actionAccept, isExactPrice && offerSt.actionAcceptWide]}
            disabled={busy}
            onPress={wrap(onAccept)}
          >
            <Text style={offerSt.actionAcceptText}>Accept</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function RequestCard({ req, onPress, chefGeoRadius, onIgnore }: {
  req: RequestItem;
  onPress: () => void;
  chefGeoRadius?: number;
  onIgnore?: () => void;
}) {
  const isThaliRequest = req.category.toLowerCase() === 'thali';
  const latestNegotiatedPrice = getLatestNegotiatedRequestPrice(req);
  const isOutOfRange =
    chefGeoRadius != null &&
    req.distanceKm != null &&
    req.distanceKm > chefGeoRadius;
  return (
    <TouchableOpacity style={cardSt.reqCard} onPress={onPress} activeOpacity={0.85}>
      <View style={cardSt.reqTop}>
        <View style={[cardSt.reqEmoji, { backgroundColor: C.blush }]}>
          <Text style={{ fontSize: 22 }}>{CATEGORY_EMOJI[req.category] ?? '🍽'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={cardSt.reqName}>{req.dishName}</Text>
          <Text style={cardSt.reqMeta}>
            {isThaliRequest ? `${req.people} plate${req.people > 1 ? 's' : ''}` : `${req.qty} kg`} · {req.people} ppl · {SPICE_LABEL[req.spiceLevel] ?? req.spiceLevel}
            {req.distanceKm != null ? ` · 📍 ${req.distanceKm} km` : ''}
          </Text>
        </View>
        <View style={cardSt.reqPriceCol}>
          <Text style={cardSt.reqBudget}>₹{req.budget}</Text>
          <Text style={cardSt.reqBudgetLabel}>original</Text>
          {latestNegotiatedPrice != null ? (
            <>
              <Text style={cardSt.reqNegotiated}>₹{latestNegotiatedPrice}</Text>
              <Text style={cardSt.reqNegotiatedLabel}>negotiated</Text>
            </>
          ) : null}
        </View>
      </View>
      <View style={cardSt.reqBottom}>
        <View style={ss.tagsRow}>
          <View style={ss.tag}><Text style={ss.tagText}>{DELIVERY_LABEL[req.delivery] ?? req.delivery}</Text></View>
          {req.preferences.slice(0, 2).map((p) => (
            <View key={p} style={ss.tag}><Text style={ss.tagText}>{p}</Text></View>
          ))}
        </View>
        <View style={cardSt.reqRight}>
          {req.quotesCount > 0 ? (
            <View style={cardSt.quotedBadge}>
              <Text style={cardSt.quotedBadgeText}>{req.quotesCount} quoted</Text>
            </View>
          ) : null}
          <Text style={cardSt.reqTime}>{timeAgo(req.createdAt)}</Text>
        </View>
      </View>
      {isOutOfRange ? (
        <>
          <View style={cardSt.outOfRangeBanner}>
            <Text style={cardSt.outOfRangeText}>
              📍 {req.distanceKm} km away · your preferred {chefGeoRadius} km
            </Text>
          </View>
          <View style={cardSt.outOfRangeActions}>
            <TouchableOpacity style={cardSt.acceptAnywayBtn} onPress={onPress} activeOpacity={0.85}>
              <Text style={cardSt.acceptAnywayText}>✅ Accept anyway</Text>
            </TouchableOpacity>
            <TouchableOpacity style={cardSt.ignoreBtn} onPress={onIgnore} activeOpacity={0.85}>
              <Text style={cardSt.ignoreBtnText}>❌ Ignore</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <TouchableOpacity style={cardSt.quoteBtn} onPress={onPress} activeOpacity={0.85}>
          <Text style={cardSt.quoteBtnText}>Submit Quote →</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

function ActiveOrderCard({ order, onPress }: { order: OrderItem; onPress: () => void }) {
  const meta = order.request.delivery === 'pickup' && order.status === 'READY'
    ? { ...ORDER_STATUS_META.READY, next: 'DELIVERED' as OrderStatus, nextLabel: '📦 Mark Delivered' }
    : ORDER_STATUS_META[order.status];
  const cookingCountdown = order.status === 'COOKING' ? countdownTo(order.readyAt) : null;
  return (
    <TouchableOpacity style={cardSt.orderCard} onPress={onPress} activeOpacity={0.85}>
      <View style={cardSt.orderTop}>
        <View style={[cardSt.orderEmoji, { backgroundColor: C.paleGreen }]}>
          <Text style={{ fontSize: 20 }}>{CATEGORY_EMOJI[order.request.category] ?? '🍽'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={cardSt.orderName}>{order.request.dishName}</Text>
          <Text style={cardSt.orderBuyer}>for {order.buyer.name}</Text>
        </View>
        <View style={[cardSt.statusBadge, { backgroundColor: meta?.bg ?? C.cream }]}>
          <Text style={[cardSt.statusText, { color: meta?.color ?? C.warmGray }]}>{meta?.label ?? order.status}</Text>
        </View>
      </View>
      {meta?.next ? (
        <View style={[cardSt.nextAction, { backgroundColor: meta.color + '18' }]}>
          <Text style={[cardSt.nextActionText, { color: meta.color }]}>{cookingCountdown ? `🍳 Ready in ${cookingCountdown}` : meta.nextLabel}</Text>
          <Text style={[cardSt.nextActionArrow, { color: meta.color }]}>›</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

function AcceptedOfferCard({ offer }: { offer: PaidDishOffer }) {
  const meta = ORDER_STATUS_META.CONFIRMED;
  return (
    <View style={cardSt.orderCard}>
      <View style={cardSt.orderTop}>
        <View style={[cardSt.orderEmoji, { backgroundColor: C.paleGreen }]}>
          <Text style={{ fontSize: 20 }}>{offer.dishEmoji}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={cardSt.orderName}>{offer.dishName}</Text>
          <Text style={cardSt.orderBuyer}>{offer.buyerName} · {offer.plates} plate{offer.plates > 1 ? 's' : ''} · ₹{(offer.agreedPrice ?? offer.offerPrice) * offer.plates}</Text>
          <Text style={cardSt.orderTime}>Paid {timeAgo(offer.paidAt ?? offer.updatedAt)} · {offer.deliveryMode === 'delivery' ? 'Home delivery' : 'Self pickup'}</Text>
        </View>
        <View style={[cardSt.statusBadge, { backgroundColor: meta.bg }]}>
          <Text style={[cardSt.statusText, { color: meta.color }]}>Paid</Text>
        </View>
      </View>
      <View style={[cardSt.nextAction, { backgroundColor: meta.color + '18' }]}>
        <Text style={[cardSt.nextActionText, { color: meta.color }]}>Buyer completed demo payment and confirmed this order</Text>
        <Text style={[cardSt.nextActionArrow, { color: meta.color }]}>✓</Text>
      </View>
    </View>
  );
}

function ManagedAcceptedOfferCard({
  offer,
  onUpdateStatus,
}: {
  offer: PaidDishOffer;
  onUpdateStatus?: (id: string, status: 'OUT_FOR_DELIVERY' | 'DELIVERED') => Promise<void>;
}) {
  const status = getPaidOfferOrderStatus(offer);
  const meta = ORDER_STATUS_META[status];
  const action = getPaidOfferAction(offer);

  return (
    <View style={cardSt.orderCard}>
      <View style={cardSt.orderTop}>
        <View style={[cardSt.orderEmoji, { backgroundColor: C.paleGreen }]}>
          <Text style={{ fontSize: 20 }}>{offer.dishEmoji}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={cardSt.orderName}>{offer.dishName}</Text>
          <Text style={cardSt.orderBuyer}>{offer.buyerName} · {offer.plates} plate{offer.plates > 1 ? 's' : ''} · ₹{(offer.agreedPrice ?? offer.offerPrice) * offer.plates}</Text>
          <Text style={cardSt.orderTime}>Paid {timeAgo(offer.paidAt ?? offer.updatedAt)} · {offer.deliveryMode === 'delivery' ? 'Home delivery' : 'Self pickup'}</Text>
        </View>
        <View style={[cardSt.statusBadge, { backgroundColor: meta.bg }]}>
          <Text style={[cardSt.statusText, { color: meta.color }]}>{meta.label}</Text>
        </View>
      </View>

      {action && onUpdateStatus ? (
        <TouchableOpacity
          style={[cardSt.nextAction, { backgroundColor: meta.color + '18' }]}
          onPress={() => onUpdateStatus(offer.id, action.next)}
          activeOpacity={0.85}
        >
          <Text style={[cardSt.nextActionText, { color: meta.color }]}>{action.label}</Text>
          <Text style={[cardSt.nextActionArrow, { color: meta.color }]}>›</Text>
        </TouchableOpacity>
      ) : (
        <View style={[cardSt.nextAction, { backgroundColor: meta.color + '18' }]}>
          <Text style={[cardSt.nextActionText, { color: meta.color }]}>
            {status === 'DELIVERED' ? 'Completed order moved to history' : 'Buyer completed demo payment and confirmed this order'}
          </Text>
          <Text style={[cardSt.nextActionArrow, { color: meta.color }]}>✓</Text>
        </View>
      )}
    </View>
  );
}

function OrderCard({ order, onPress }: { order: OrderItem; onPress: () => void }) {
  const meta = ORDER_STATUS_META[order.status];
  return (
    <TouchableOpacity style={cardSt.orderCard} onPress={onPress} activeOpacity={0.85}>
      <View style={cardSt.orderTop}>
        <View style={[cardSt.orderEmoji, { backgroundColor: C.cream }]}>
          <Text style={{ fontSize: 20 }}>{CATEGORY_EMOJI[order.request.category] ?? '🍽'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={cardSt.orderName}>{order.request.dishName}</Text>
          <Text style={cardSt.orderBuyer}>{order.buyer.name} · ₹{order.finalPrice}</Text>
          <Text style={cardSt.orderTime}>{timeAgo(order.createdAt)}</Text>
        </View>
        <View style={[cardSt.statusBadge, { backgroundColor: meta?.bg ?? C.cream }]}>
          <Text style={[cardSt.statusText, { color: meta?.color ?? C.warmGray }]}>{meta?.label ?? order.status}</Text>
        </View>
      </View>
      {order.review ? (
        <View style={cardSt.reviewRow}>
          {[1,2,3,4,5].map((i) => <Text key={i} style={{ color: i <= order.review!.rating ? C.turmeric : C.border, fontSize: 11 }}>★</Text>)}
          {order.review.comment ? <Text style={cardSt.reviewText} numberOfLines={1}> "{order.review.comment}"</Text> : null}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

function StatusPill({ status }: { status: string }) {
  const meta = ORDER_STATUS_META[status] ?? { label: status, color: C.warmGray, bg: C.cream };
  return (
    <View style={[{ backgroundColor: meta.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }]}>
      <Text style={{ fontSize: 9, fontWeight: '700', color: meta.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {meta.label}
      </Text>
    </View>
  );
}

function CenteredLoader() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color={C.mint} />
    </View>
  );
}

function ErrorView({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ fontSize: 40, marginBottom: 12 }}>⚠️</Text>
      <Text style={{ fontSize: 15, color: C.ink, fontWeight: '600', marginBottom: 8, textAlign: 'center' }}>{message}</Text>
      <TouchableOpacity style={{ marginTop: 16, backgroundColor: C.mint, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 }} onPress={onBack}>
        <Text style={{ color: C.white, fontWeight: '700' }}>Go Back</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────────────────────────────────
const navSt = StyleSheet.create({
  nav: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    backgroundColor: C.white,
    paddingBottom: 24,
    paddingTop: 14,
    paddingHorizontal: 10,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    shadowColor: 'rgba(0,0,0,0.12)',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 1,
    shadowRadius: 20,
    elevation: 16,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    gap: 4,
  },
  activeIndicator: {
    position: 'absolute',
    top: -14,
    width: 36,
    height: 3,
    borderRadius: 3,
    backgroundColor: C.mint,
  },
  icon: { fontSize: 22, opacity: 0.4 },
  iconActive: { opacity: 1 },
  label: { fontSize: 11, fontWeight: '600', color: C.warmGray },
  labelActive: { color: C.mint, fontWeight: '800' },
});

const ss = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: C.cream },
  scroll:      { flex: 1 },
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.white, paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  backBtn:     { width: 34, height: 34, borderRadius: 10, backgroundColor: C.cream, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  backIcon:    { fontSize: 18, color: C.ink },
  headerTitle: { fontSize: 17, fontWeight: '700', color: C.ink },
  sectionRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle:{ fontSize: 14, fontWeight: '700', color: C.ink },
  seeAll:      { fontSize: 12, color: C.mint, fontWeight: '600' },
  mutedText:   { fontSize: 12, color: C.warmGray },
  fieldLabel:  { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, color: C.warmGray, marginBottom: 7, marginTop: 14 },
  input:       { backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 12 : 10, fontSize: 14, color: C.ink },
  chipRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:        { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white },
  chipActive:  { borderColor: C.mint, backgroundColor: C.mintLight },
  chipText:    { fontSize: 12, fontWeight: '600', color: C.warmGray },
  chipTextActive: { color: C.mint },
  tagsRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 },
  tag:         { backgroundColor: C.cream, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3 },
  tagText:     { fontSize: 10, color: C.warmGray, fontWeight: '500' },
  errorText:   { color: C.red, fontSize: 12, marginTop: 8 },
});

const authSt = StyleSheet.create({
  scroll:       { flexGrow: 1, padding: 24, paddingTop: 48 },
  brandWrap:    { alignItems: 'center', marginBottom: 32 },
  brandIcon:    { width: 80, height: 80, borderRadius: 24, backgroundColor: C.mintLight, alignItems: 'center', justifyContent: 'center', marginBottom: 14, shadowColor: C.mint, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 5 },
  brandEmoji:   { fontSize: 40 },
  brandTitle:   { fontSize: 26, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
  brandSub:     { fontSize: 13, color: C.mint, fontWeight: '600', marginTop: 2 },
  tabs:         { flexDirection: 'row', backgroundColor: C.cream, borderRadius: 12, padding: 4, marginBottom: 24, borderWidth: 1, borderColor: C.border },
  tab:          { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  tabActive:    { backgroundColor: C.white, shadowColor: C.ink, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 4, elevation: 1 },
  tabText:      { fontSize: 13, fontWeight: '600', color: C.warmGray },
  tabTextActive:{ color: C.ink },
  form:         { gap: 2 },
  label:        { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, color: C.warmGray, marginBottom: 6, marginTop: 12 },
  input:        { backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 13 : 11, fontSize: 15, color: C.ink },
  error:        { fontSize: 12, color: C.red, marginTop: 8, textAlign: 'center' },
  submitBtn:    { marginTop: 20, backgroundColor: C.mint, borderRadius: 14, paddingVertical: 15, alignItems: 'center', shadowColor: C.mint, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 4 },
  submitText:   { color: C.white, fontSize: 15, fontWeight: '700' },
  note:         { marginTop: 24, textAlign: 'center', fontSize: 11, color: C.warmGray, lineHeight: 17 },
});

const homeSt = StyleSheet.create({
  scrollContent: { paddingHorizontal: 20, paddingTop: 16 },
  // Header
  header:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  brandWrap:     { flex: 1, paddingRight: 16, justifyContent: 'center', minHeight: 52 },
  brandRow:      { flexDirection: 'row', alignItems: 'baseline' },
  brandFood:     { fontSize: 31, fontWeight: '800', color: '#1A1A18', letterSpacing: -1.1 },
  brandSood:     { fontSize: 31, fontWeight: '800', color: C.mint, letterSpacing: -1.1 },
  avatarWrapper: { position: 'relative' },
  avatar:        { width: 52, height: 52, borderRadius: 26, backgroundColor: C.mint, alignItems: 'center', justifyContent: 'center', shadowColor: C.mint, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 10, elevation: 8 },
  avatarText:    { color: C.white, fontSize: 22, fontWeight: '800' },
  avatarOnline:  { position: 'absolute', right: 2, top: 2, width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: C.bg },
  // Location
  locationRow:   { flexDirection: 'row', gap: 10, marginBottom: 16 },
  locationChip:  { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: C.white, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 50, shadowColor: C.shadow, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 1, shadowRadius: 8, elevation: 3 },
  locationPin:   { fontSize: 14, marginRight: 4 },
  locationText:  { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600', color: '#1A2620' },
  locationCaret: { fontSize: 11, color: '#8FA89E' },
  rangeChip:     { backgroundColor: C.accent, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 50, borderWidth: 1, borderColor: C.accentStrong, justifyContent: 'center' },
  rangeText:     { fontSize: 13, fontWeight: '700', color: C.mint },
  // Toggle
  toggleCard:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.white, padding: 18, borderRadius: 20, marginBottom: 18, shadowColor: C.shadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 12, elevation: 4 },
  toggleLeft:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggleDot:     { width: 10, height: 10, borderRadius: 5, backgroundColor: '#D1D9D6' },
  toggleDotActive: { backgroundColor: '#4ADE80' },
  toggleLabel:   { fontSize: 16, fontWeight: '700', color: '#1A2620' },
  // Stats
  statsRow:          { flexDirection: 'row', gap: 10, marginBottom: 18 },
  statCard:          { flex: 1, backgroundColor: C.white, borderRadius: 18, paddingVertical: 20, paddingHorizontal: 10, alignItems: 'center', shadowColor: C.shadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 10, elevation: 4 },
  statCardEarnings:  { backgroundColor: C.earningsBg, overflow: 'hidden' },
  statGlow:          { position: 'absolute', top: -20, right: -20, width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(78,189,150,0.3)' },
  statValue:         { fontSize: 26, fontWeight: '800', color: '#1A2620', letterSpacing: -0.5 },
  statValueEarnings: { color: C.white },
  statLabel:         { fontSize: 9, fontWeight: '700', color: '#8FA89E', letterSpacing: 0.8, marginTop: 4, textAlign: 'center' },
  statLabelEarnings: { color: 'rgba(255,255,255,0.7)' },
  // Culinary card
  culinaryCard:    { backgroundColor: C.white, borderRadius: 24, marginBottom: 24, overflow: 'hidden', shadowColor: C.shadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 1, shadowRadius: 16, elevation: 6 },
  culinaryStrip:   { position: 'absolute', top: -30, right: -30, width: 120, height: 120, borderRadius: 60, backgroundColor: C.accent },
  culinaryContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 22 },
  culinaryLeft:    { flex: 1, paddingRight: 16 },
  culinaryTag:     { fontSize: 10, fontWeight: '800', color: C.mint, letterSpacing: 1.2, marginBottom: 8 },
  culinaryTitle:   { fontSize: 18, fontWeight: '800', color: '#1A2620', lineHeight: 24, marginBottom: 8 },
  culinarySubtitle:{ fontSize: 12, color: '#4A6558', lineHeight: 17 },
  todayBadge:      { width: 68, height: 68, borderRadius: 20, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.accentStrong },
  todayNumber:     { fontSize: 28, fontWeight: '900', color: C.mint, lineHeight: 32 },
  todayLabel:      { fontSize: 9, fontWeight: '800', color: C.mint, letterSpacing: 1 },
  // Sections
  section:       { marginBottom: 8 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle:  { fontSize: 18, fontWeight: '800', color: '#1A2620', letterSpacing: -0.3 },
  seeAll:        { fontSize: 12, color: C.mint, fontWeight: '600' },
  badge:         { backgroundColor: C.accentStrong, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 50 },
  badgeText:     { fontSize: 11, fontWeight: '700', color: C.mint },
  // Request board
  requestCard: { backgroundColor: C.white, borderRadius: 24, overflow: 'hidden', shadowColor: C.shadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 1, shadowRadius: 16, elevation: 6, marginBottom: 8 },
  geoBar:      { flexDirection: 'row', alignItems: 'center', backgroundColor: C.accent, paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  geoIcon:     { fontSize: 14 },
  geoText:     { flex: 1, fontSize: 12, fontWeight: '600', color: C.mint },
  geoChange:   { fontSize: 12, fontWeight: '800', color: C.mint, textDecorationLine: 'underline' },
  emptyState:  { alignItems: 'center', paddingVertical: 44, paddingHorizontal: 24 },
  emptyEmoji:  { fontSize: 48, marginBottom: 16 },
  emptyTitle:  { fontSize: 17, fontWeight: '800', color: '#1A2620', marginBottom: 8 },
  emptySub:    { fontSize: 13, color: '#4A6558', textAlign: 'center', lineHeight: 19, marginBottom: 20 },
  expandBtn:   { backgroundColor: C.mint, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 50, shadowColor: C.mint, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 5 },
  expandBtnText: { color: C.white, fontSize: 13, fontWeight: '800', letterSpacing: 0.4 },
});

const rdSt = StyleSheet.create({
  dishCard:     { backgroundColor: C.white, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  dishTop:      { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  dishEmojiWrap:{ width: 50, height: 50, borderRadius: 14, backgroundColor: C.blush, alignItems: 'center', justifyContent: 'center' },
  dishEmoji:    { fontSize: 26 },
  dishName:     { fontSize: 18, fontWeight: '800', color: C.ink, letterSpacing: -0.3 },
  dishSub:      { fontSize: 11, color: C.warmGray, marginTop: 2 },
  budgetAmt:    { fontSize: 22, fontWeight: '800', color: C.mint },
  specGrid:     { flexDirection: 'row', gap: 8, marginBottom: 10 },
  specItem:     { flex: 1, backgroundColor: C.cream, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  specVal:      { fontSize: 12, fontWeight: '700', color: C.ink },
  specLabel:    { fontSize: 9, color: C.warmGray, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.4 },
  noteBox:      { marginTop: 10, backgroundColor: C.paleYellow, borderRadius: 8, padding: 10 },
  noteText:     { fontSize: 12, color: C.ink, fontStyle: 'italic', lineHeight: 18 },
  buyerRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.white, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border, marginBottom: 14 },
  buyerAv:      { width: 38, height: 38, borderRadius: 19, backgroundColor: C.blush, alignItems: 'center', justifyContent: 'center' },
  buyerAvText:  { fontSize: 16, fontWeight: '700', color: C.spice },
  buyerName:    { fontSize: 14, fontWeight: '700', color: C.ink },
  buyerCity:    { fontSize: 11, color: C.warmGray },
  buyerRating:  { backgroundColor: C.paleYellow, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  buyerRatingText: { fontSize: 12, fontWeight: '700', color: '#B07800' },
  myQuoteCard:  { backgroundColor: C.mintLight, borderRadius: 14, padding: 14, borderWidth: 1.5, borderColor: C.mint, marginBottom: 16 },
  myQuoteTop:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  myQuoteTitle: { fontSize: 13, fontWeight: '700', color: C.mintDark },
  myQuotePrice: { fontSize: 28, fontWeight: '800', color: C.ink },
  myQuoteMeta:  { fontSize: 12, color: C.warmGray, marginTop: 2 },
  counterMetaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 10 },
  counterMetaText: { flex: 1, fontSize: 11, fontWeight: '700', color: C.mintDark },
  counterBox:   { marginTop: 10, backgroundColor: C.paleYellow, borderRadius: 8, padding: 10 },
  counterText:  { fontSize: 12, color: C.ink, fontWeight: '600' },
  actionRow:    { flexDirection: 'row', gap: 8, marginTop: 12 },
  withdrawBtn:  { marginTop: 12, paddingVertical: 9, borderRadius: 9, borderWidth: 1.5, borderColor: C.red, alignItems: 'center' },
  withdrawBtnText: { fontSize: 13, fontWeight: '600', color: C.red },
  quoteForm:    { backgroundColor: C.white, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border },
  formTitle:    { fontSize: 16, fontWeight: '700', color: C.ink, marginBottom: 2 },
  limitHint:    { fontSize: 11, fontWeight: '700', color: C.mint, marginTop: 4, marginBottom: 12 },
  priceRow:     { flexDirection: 'row', alignItems: 'center', backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14 },
  rupee:        { fontSize: 20, fontWeight: '700', color: C.warmGray, marginRight: 6 },
  priceInput:   { flex: 1, fontSize: 28, fontWeight: '700', color: C.ink, paddingVertical: Platform.OS === 'ios' ? 12 : 9 },
  budgetHint:   { fontSize: 11, color: C.warmGray, marginTop: 5 },
  cookTimeRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  cookChip:     { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white },
  cookChipActive:{ borderColor: C.mint, backgroundColor: C.mintLight },
  cookChipText: { fontSize: 12, fontWeight: '600', color: C.warmGray },
  cookChipTextActive: { color: C.mint },
  msgInput:     { backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, padding: 12, fontSize: 13, color: C.ink, lineHeight: 20, minHeight: 80 },
  formActionRow:{ flexDirection: 'row', gap: 10, marginTop: 16 },
  formSecondaryBtn: { minWidth: 110, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.cream, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  formSecondaryBtnText: { fontSize: 14, fontWeight: '700', color: C.warmGray },
  submitBtn:    { marginTop: 16, backgroundColor: C.mint, borderRadius: 12, paddingVertical: 14, alignItems: 'center', shadowColor: C.mint, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 3 },
  submitBtnText:{ color: C.white, fontSize: 15, fontWeight: '700' },
  closedBox:    { backgroundColor: C.cream, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  closedText:   { fontSize: 13, color: C.warmGray, textAlign: 'center' },
});

const ordSt = StyleSheet.create({
  tabBar:       { flexDirection: 'row', backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.border },
  tabBtn:       { flex: 1, paddingVertical: 13, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: C.mint },
  tabBtnText:   { fontSize: 13, fontWeight: '600', color: C.warmGray },
  tabBtnTextActive: { color: C.mint },
  empty:        { alignItems: 'center', paddingVertical: 48 },
  emptyEmoji:   { fontSize: 44, marginBottom: 12 },
  emptyText:    { fontSize: 14, color: C.warmGray, fontWeight: '500' },
});

const odSt = StyleSheet.create({
  summaryCard:  { backgroundColor: C.white, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  summaryTop:   { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  dishIcon:     { width: 50, height: 50, borderRadius: 14, backgroundColor: C.paleGreen, alignItems: 'center', justifyContent: 'center' },
  dishName:     { fontSize: 17, fontWeight: '800', color: C.ink },
  dishMeta:     { fontSize: 12, color: C.warmGray, marginTop: 2 },
  priceBox:     { alignItems: 'flex-end' },
  priceAmt:     { fontSize: 20, fontWeight: '800', color: C.mint },
  priceLabel:   { fontSize: 9, color: C.warmGray, textTransform: 'uppercase' },
  deliveryRow:  { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border },
  deliveryText: { fontSize: 12, fontWeight: '600', color: C.ink },
  addressText:  { fontSize: 12, color: C.warmGray },
  buyerCard:    { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.white, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  buyerAv:      { width: 40, height: 40, borderRadius: 20, backgroundColor: C.blush, alignItems: 'center', justifyContent: 'center' },
  buyerAvText:  { fontSize: 17, fontWeight: '700', color: C.spice },
  buyerName:    { fontSize: 14, fontWeight: '700', color: C.ink },
  buyerPhone:   { fontSize: 11, color: C.warmGray, marginTop: 2 },
  buyerActionRow:{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  buyerActionBtn:{ paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: C.border, backgroundColor: C.white },
  buyerActionBtnActive: { backgroundColor: '#FFF0F0', borderColor: '#F3C7C7' },
  buyerActionText:{ fontSize: 11, fontWeight: '700', color: C.ink },
  callBtn:      { backgroundColor: C.mintLight, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  callBtnText:  { fontSize: 12, fontWeight: '700', color: C.mint },
  timelineCard: { backgroundColor: C.white, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  timelineTitle:{ fontSize: 13, fontWeight: '700', color: C.ink, marginBottom: 14 },
  timerBanner:  { alignSelf: 'flex-start', backgroundColor: C.paleYellow, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 12 },
  timerBannerText:{ fontSize: 12, fontWeight: '800', color: '#B07800' },
  timeline:     { gap: 0 },
  timelineRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  timelineDotCol:{ alignItems: 'center', width: 20 },
  timelineDot:  { width: 14, height: 14, borderRadius: 7, backgroundColor: C.border, borderWidth: 2, borderColor: C.border },
  timelineDotDone:{ backgroundColor: C.mint, borderColor: C.mint },
  timelineDotCurrent: { width: 16, height: 16, borderRadius: 8, backgroundColor: C.white, borderColor: C.mint, borderWidth: 3, shadowColor: C.mint, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 4, elevation: 2 },
  timelineLine: { width: 2, height: 28, backgroundColor: C.border, marginTop: 2 },
  timelineLineDone: { backgroundColor: C.mint },
  timelineLabel:{ fontSize: 13, fontWeight: '500', color: C.warmGray, paddingVertical: 1, marginBottom: 16 },
  timelineLabelDone: { color: C.ink, fontWeight: '700' },
  reviewCard:   { backgroundColor: C.paleYellow, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#F0E0A0', marginBottom: 14 },
  reviewTitle:  { fontSize: 13, fontWeight: '700', color: C.ink, marginBottom: 8 },
  reviewComment:{ fontSize: 12, color: C.warmGray, fontStyle: 'italic', marginTop: 6 },
  actionBtn:    { borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginBottom: 10, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.25, shadowRadius: 10, elevation: 3 },
  actionBtnText:{ color: C.white, fontSize: 16, fontWeight: '700' },
  cancelBtn:    { paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, borderColor: C.red, alignItems: 'center', marginBottom: 16 },
  cancelBtnText:{ fontSize: 14, fontWeight: '600', color: C.red },
  orderedAt:    { textAlign: 'center', fontSize: 11, color: C.warmGray },
});

const earnSt = StyleSheet.create({
  heroCard:     { backgroundColor: C.mint, borderRadius: 20, padding: 24, marginBottom: 16, alignItems: 'center' },
  heroLabel:    { fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: 0.8 },
  heroAmt:      { fontSize: 40, fontWeight: '800', color: C.white, marginVertical: 6 },
  heroSub:      { fontSize: 12, color: 'rgba(255,255,255,0.65)', marginBottom: 20 },
  payoutBtn:    { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  payoutBtnText:{ color: C.white, fontSize: 13, fontWeight: '700' },
  monthCard:    { backgroundColor: C.white, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border, marginBottom: 14 },
  monthTitle:   { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 14 },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border },
  breakdownRowHL:{ backgroundColor: C.mintLight, marginHorizontal: -16, paddingHorizontal: 16, borderRadius: 8, borderTopWidth: 0, marginTop: 4, paddingTop: 10 },
  breakdownLabel:{ fontSize: 13, color: C.warmGray },
  breakdownLabelHL: { color: C.mintDark, fontWeight: '700' },
  breakdownVal: { fontSize: 13, fontWeight: '700', color: C.ink },
  breakdownValHL:{ color: C.mint, fontSize: 15 },
  tipCard:      { backgroundColor: C.white, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: C.border },
  tipTitle:     { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 12 },
  tipRow:       { flexDirection: 'row', gap: 10, marginBottom: 10, alignItems: 'flex-start' },
  tipIcon:      { fontSize: 16, marginTop: 1 },
  tipText:      { flex: 1, fontSize: 12, color: C.warmGray, lineHeight: 18 },
});

const profSt = StyleSheet.create({
  saveBtn:      { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: C.mint },
  saveBtnText:  { color: C.white, fontSize: 12, fontWeight: '700' },
  hero:         { backgroundColor: C.mintLight, borderRadius: 16, padding: 16, alignItems: 'center', marginBottom: 14, overflow: 'hidden' },
  coverCard:    { width: '100%', height: 148, borderRadius: 16, backgroundColor: '#D6ECE2', marginBottom: 18, overflow: 'hidden', justifyContent: 'flex-end' },
  coverImage:   { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  coverOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,24,22,0.16)' },
  coverBadge:   { alignSelf: 'flex-end', margin: 12, backgroundColor: 'rgba(17,24,22,0.68)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  coverBadgeText: { color: C.white, fontSize: 11, fontWeight: '800' },
  avatarWrap:   { marginTop: -54, marginBottom: 10, position: 'relative' },
  avatar:       { width: 92, height: 92, borderRadius: 46, backgroundColor: C.mint, alignItems: 'center', justifyContent: 'center', shadowColor: C.mint, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 4, borderWidth: 4, borderColor: C.white, overflow: 'hidden' },
  avatarImage:  { width: '100%', height: '100%' },
  avatarText:   { color: C.white, fontSize: 28, fontWeight: '800' },
  avatarEditBadge: { position: 'absolute', right: -2, bottom: 4, minWidth: 28, height: 28, borderRadius: 14, paddingHorizontal: 6, backgroundColor: C.ink, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.white },
  avatarEditBadgeText: { color: C.white, fontSize: 12 },
  heroHint:     { fontSize: 11, color: C.warmGray, textAlign: 'center', lineHeight: 16, marginBottom: 12, paddingHorizontal: 14 },
  statsRow:     { flexDirection: 'row', backgroundColor: C.white, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: C.border, width: '100%' },
  statItem:     { flex: 1, paddingVertical: 12, alignItems: 'center' },
  statNum:      { fontSize: 16, fontWeight: '800', color: C.ink },
  statLabel:    { fontSize: 9, color: C.warmGray, textTransform: 'uppercase', letterSpacing: 0.4 },
  statDivider:  { width: 1, backgroundColor: C.border, alignSelf: 'stretch', marginVertical: 8 },
  availRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.white, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, marginBottom: 4 },
  availLeft:    { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  dot:          { width: 10, height: 10, borderRadius: 5 },
  availTitle:   { fontSize: 14, fontWeight: '700', color: C.ink },
  availSub:     { fontSize: 11, color: C.warmGray, marginTop: 1 },
  locationCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.white, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, marginBottom: 4 },
  locationCardCopy: { flex: 1, paddingRight: 10 },
  locationCardTitle: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, color: C.warmGray, marginBottom: 6 },
  locationCardValue: { fontSize: 14, fontWeight: '700', color: C.ink },
  locationCardSub: { fontSize: 11, color: C.warmGray, marginTop: 4, lineHeight: 16 },
  locationCardAction: { fontSize: 12, fontWeight: '700', color: C.mint },
  field:        { marginBottom: 2 },
  input:        { backgroundColor: C.cream, borderWidth: 1.5, borderColor: C.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 12 : 10, fontSize: 14, color: C.ink },
  phone:        { fontSize: 13, color: C.warmGray, textAlign: 'center', marginTop: 20, marginBottom: 6 },
  logoutBtn:    { marginTop: 10, paddingVertical: 13, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, alignItems: 'center' },
  logoutText:   { fontSize: 14, fontWeight: '600', color: C.warmGray },

  // Kitchen images
  kitchenSection: { marginTop: 6, marginBottom: 4 },
  kitchenHint:    { fontSize: 11, color: C.warmGray, marginBottom: 12, marginTop: 3 },
  kitchenGrid:    { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  kitchenSlot:    { width: 64, height: 64, borderRadius: 12, overflow: 'hidden' },
  kitchenImg:     { width: 64, height: 64, borderRadius: 12 },
  kitchenAddBtn:  { width: 64, height: 64, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: C.cream },
  kitchenAddIcon: { fontSize: 24, color: C.warmGray, lineHeight: 28 },
  kitchenRemoveBtn: { position: 'absolute', top: 2, right: 2, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  kitchenRemoveText: { color: C.white, fontSize: 10, fontWeight: '800', lineHeight: 12 },

  // Speciality dishes
  specialitySection: { marginTop: 10, marginBottom: 4 },
  specialityHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  specialityHeaderCopy: { flex: 1 },
  specialityHint: { fontSize: 11, color: C.warmGray, marginTop: 3, lineHeight: 16 },
  specialityAddBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: C.mintLight, borderWidth: 1, borderColor: '#BDE5D0' },
  specialityAddBtnText: { fontSize: 12, fontWeight: '700', color: C.mintDark },
  specialityEmpty: { backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 16 },
  specialityEmptyTitle: { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 4 },
  specialityEmptySub: { fontSize: 12, color: C.warmGray, lineHeight: 18 },
  specialityCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.white, borderRadius: 16, borderWidth: 1, borderColor: C.border, overflow: 'hidden', marginBottom: 10 },
  specialityImage: { width: 78, height: 78, backgroundColor: C.cream },
  specialityBody: { flex: 1, paddingHorizontal: 14, paddingVertical: 12 },
  specialityName: { fontSize: 14, fontWeight: '800', color: C.ink, marginBottom: 4 },
  specialityReviewMeta: { fontSize: 11, color: C.spice, marginBottom: 4, fontWeight: '700' },
  specialityDescription: { fontSize: 13, color: C.ink, lineHeight: 18, marginBottom: 6 },
  specialityUnits: { fontSize: 12, color: C.warmGray, marginBottom: 4 },
  specialityReviewQuote: { fontSize: 11, color: C.warmGray, marginBottom: 4, fontStyle: 'italic' },
  specialityPrice: { fontSize: 12, fontWeight: '700', color: C.mintDark },
});

const todaySt = StyleSheet.create({
  // scroll
  scrollContent: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 120 },

  // top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.bg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 14,
    backgroundColor: C.white,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 1, shadowRadius: 6, elevation: 3,
  },
  backIcon: { fontSize: 18, color: C.ink, fontWeight: '700' },
  topTitle: { fontSize: 18, fontWeight: '800', color: C.ink, letterSpacing: -0.3 },

  // section header
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14,
  },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: C.ink, letterSpacing: -0.3 },
  sectionBadge: { backgroundColor: C.accentStrong, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 50 },
  sectionBadgeText: { fontSize: 11, fontWeight: '700', color: C.mint },

  // empty state
  emptyCard: {
    alignItems: 'center', paddingVertical: 34,
    backgroundColor: C.white, borderRadius: 22,
    shadowColor: C.shadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 1, shadowRadius: 12, elevation: 4,
    marginBottom: 14,
  },
  emptyEmoji: { fontSize: 34, marginBottom: 10 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: C.ink, marginBottom: 4 },
  emptySub: { fontSize: 12, color: C.warmGray, textAlign: 'center', paddingHorizontal: 22 },

  // dish card
  dishCard: {
    flexDirection: 'row',
    backgroundColor: C.white,
    borderRadius: 22,
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: C.shadow,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 1,
    shadowRadius: 14,
    elevation: 5,
  },
  dishCardLeft: {
    width: 90,
    backgroundColor: C.blush,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    borderRightWidth: 1,
    borderRightColor: '#FFD6C8',
    gap: 8,
  },
  dishCardEmoji: { fontSize: 36 },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(46,139,110,0.12)',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 50,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ADE80' },
  liveDotLive: { backgroundColor: '#4ADE80' },
  liveText: { fontSize: 10, fontWeight: '700', color: C.mint },
  liveTextLive: { color: '#4ADE80', fontWeight: '900', letterSpacing: 0.5 },
  liveBadgeLive: { backgroundColor: 'rgba(74,222,128,0.18)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)' },
  dishCardPhoto: { width: 64, height: 64, borderRadius: 14 },
  dishCardRight: { flex: 1, padding: 16 },
  dishCardTopRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8,
  },
  dishCardName: { fontSize: 17, fontWeight: '800', color: C.ink, flex: 1 },
  dishStatusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0, marginLeft: 8 },
  dishStatusReady: { backgroundColor: '#EDFAF3', borderWidth: 1, borderColor: '#B5EDCE' },
  dishStatusCooking: { backgroundColor: C.paleYellow },
  dishStatusText: { fontSize: 10, fontWeight: '700', color: '#1B7A47' },
  dishCardMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  tagPill: { backgroundColor: C.mint, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 50 },
  tagPillText: { fontSize: 11, fontWeight: '700', color: C.white },
  dishCardSub: { fontSize: 12, color: C.warmGray },
  dishCardDetail: { fontSize: 12, color: C.warmGray, marginBottom: 4 },
  dishCardNote: { fontSize: 12, color: '#9EB5AA', marginBottom: 8 },
  removeText: { fontSize: 12, fontWeight: '700', color: C.red },

  // culinary banner
  culinaryBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: C.earningsBg,
    borderRadius: 26,
    paddingHorizontal: 22,
    paddingVertical: 22,
    marginBottom: 18,
    marginTop: 8,
    overflow: 'hidden',
    position: 'relative',
    shadowColor: C.mint,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
    elevation: 8,
  },
  culinaryBannerBlob: {
    position: 'absolute', width: 140, height: 140, borderRadius: 70,
    backgroundColor: 'rgba(78,189,150,0.15)', top: -50, right: -20,
  },
  culinaryBannerBlobSmall: {
    position: 'absolute', width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(168,230,207,0.1)', bottom: -30, left: 30,
  },
  bannerTag: { fontSize: 10, fontWeight: '800', color: C.accentStrong, letterSpacing: 1.3, marginBottom: 10 },
  bannerTitle: { fontSize: 20, fontWeight: '900', color: C.white, lineHeight: 26, letterSpacing: -0.3, marginBottom: 6 },
  bannerSub: { fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 17 },
  bannerSteam: { alignItems: 'center', paddingLeft: 16 },
  bannerSteamDots: { flexDirection: 'row', gap: 5, marginBottom: 4, height: 20, alignItems: 'flex-end' },
  steamDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.accentStrong },
  bannerPot: {
    width: 68, height: 68, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(168,230,207,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  bannerPotEmoji: { fontSize: 32 },

  // form card
  formCard: {
    backgroundColor: C.white,
    borderRadius: 28,
    overflow: 'hidden',
    shadowColor: C.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 1,
    shadowRadius: 18,
    elevation: 6,
    marginBottom: 10,
  },
  formHeader: {
    backgroundColor: C.accent,
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: C.accentStrong,
  },
  formTitle: { fontSize: 18, fontWeight: '800', color: C.ink, letterSpacing: -0.2 },
  formSection: { paddingHorizontal: 20, paddingTop: 20 },
  fieldLabel: { fontSize: 10, fontWeight: '800', color: '#9EB5AA', letterSpacing: 1.2, marginBottom: 10 },
  textInput: {
    backgroundColor: C.bg,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 14,
    color: C.ink,
    borderWidth: 1.5,
    borderColor: '#E4EDE9',
    fontWeight: '500',
  },
  suggestionMenu: {
    marginTop: 10,
    backgroundColor: C.white,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E4EDE9',
    overflow: 'hidden',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#EEF2EF',
  },
  suggestionCopy: { flex: 1, paddingRight: 12 },
  suggestionTitle: { fontSize: 14, fontWeight: '700', color: C.ink, marginBottom: 3 },
  suggestionMeta: { fontSize: 12, color: C.warmGray },
  suggestionAction: { fontSize: 12, fontWeight: '800', color: C.mintDark },
  notesInput: { height: 110, textAlignVertical: 'top' },

  // emoji grid
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  emojiChip: {
    width: '23%', aspectRatio: 1,
    backgroundColor: C.bg, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#E4EDE9', gap: 4,
  },
  emojiChipActive: { backgroundColor: C.accent, borderColor: C.mint, borderWidth: 2 },
  emojiIcon: { fontSize: 26 },
  emojiLabel: { fontSize: 11, fontWeight: '600', color: C.warmGray },
  emojiLabelActive: { color: C.mint, fontWeight: '800' },
  emojiHintBox: { backgroundColor: C.bg, borderRadius: 12, padding: 12, marginTop: 12, borderLeftWidth: 3, borderLeftColor: C.accentStrong },
  emojiHint: { fontSize: 11, color: C.warmGray, lineHeight: 17 },

  // cuisine / dish tags
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cuisineTag: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 50,
    backgroundColor: C.bg, borderWidth: 1.5, borderColor: '#DDE8E3',
  },
  cuisineTagSelected: { backgroundColor: C.earningsBg, borderColor: C.earningsBg },
  cuisineTagText: { fontSize: 13, fontWeight: '600', color: C.warmGray },
  cuisineTagTextSelected: { color: C.white, fontWeight: '800' },
  addTagBtn: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 50,
    borderWidth: 2, borderColor: C.mint, backgroundColor: 'transparent',
  },
  addTagBtnActive: { backgroundColor: C.mintLight },
  addTagBtnText: { fontSize: 13, fontWeight: '800', color: C.mint },
  customTagBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  customTagSave: { backgroundColor: C.mint, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14 },
  customTagSaveText: { color: C.white, fontSize: 13, fontWeight: '700' },

  // divider
  divider: { height: 1, backgroundColor: '#EDF2EF', marginHorizontal: 20, marginTop: 24 },

  // price row
  priceRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.bg, borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 14,
    borderWidth: 1.5, borderColor: '#E4EDE9', gap: 8,
  },
  rupeeSign: { fontSize: 20, fontWeight: '800', color: C.mint },
  priceInput: { flex: 1, fontSize: 22, fontWeight: '900', color: C.ink, padding: 0 },
  perPlate: { fontSize: 13, color: '#9EB5AA', fontWeight: '500' },

  // stepper
  portionCard: {
    backgroundColor: C.bg, borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 14,
    borderWidth: 1.5, borderColor: '#E4EDE9',
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperLabel: { fontSize: 14, fontWeight: '700', color: C.ink },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: C.white, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#DDE8E3',
    shadowColor: C.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 1, shadowRadius: 4, elevation: 2,
  },
  stepBtnText: { fontSize: 18, fontWeight: '700', color: C.mint },
  stepperValue: { fontSize: 20, fontWeight: '900', color: C.ink, minWidth: 28, textAlign: 'center' },

  // segmented
  segmented: {
    flexDirection: 'row',
    backgroundColor: C.bg, borderRadius: 14,
    padding: 4, borderWidth: 1.5, borderColor: '#E4EDE9', marginBottom: 12,
  },
  segOption: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  segOptionSelected: { backgroundColor: C.mint },
  segOptionText: { fontSize: 13, fontWeight: '700', color: C.warmGray },
  segOptionTextSelected: { color: C.white, fontWeight: '800' },
  measureRow: { flexDirection: 'row', gap: 10 },

  // slider
  sliderCard: {
    backgroundColor: C.bg, borderRadius: 14,
    padding: 16, borderWidth: 1.5, borderColor: '#E4EDE9',
  },
  sliderTopRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  sliderTitle: { fontSize: 14, fontWeight: '700', color: C.ink },
  sliderValue: { fontSize: 14, fontWeight: '800', color: C.mint },
  readySlider: { width: '100%', height: 36 },
  sliderLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  sliderTickLabel: { fontSize: 10, color: '#9EB5AA', fontWeight: '600' },

  // CTA
  ctaBtn: {
    margin: 20,
    backgroundColor: C.mint,
    borderRadius: 20,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: C.mint,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.38,
    shadowRadius: 12,
    elevation: 8,
  },
  ctaBtnText: { fontSize: 16, fontWeight: '900', color: C.white, letterSpacing: 0.3 },
});

const mSt = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  sheet: {
    width: '100%', backgroundColor: C.white,
    borderRadius: 28, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.22, shadowRadius: 24, elevation: 20,
  },

  // ── Timer Expired ─────────────────────────────────────────────────────
  timerIconWrap: { alignItems: 'center', marginTop: 28, marginBottom: 6 },
  timerIcon: { fontSize: 44 },
  sheetTitle: { fontSize: 24, fontWeight: '900', color: C.ink, textAlign: 'center', letterSpacing: -0.4, marginTop: 4 },
  sheetDish: { fontSize: 15, fontWeight: '600', color: C.warmGray, textAlign: 'center', marginTop: 4, paddingHorizontal: 24 },
  sheetSub: { fontSize: 13, color: C.warmGray, textAlign: 'center', marginTop: 6, marginBottom: 20, paddingHorizontal: 28 },
  extendLabel: { fontSize: 10, fontWeight: '800', color: '#9EB5AA', letterSpacing: 1.2, textAlign: 'center', marginBottom: 12 },
  extendRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, paddingHorizontal: 20, marginBottom: 20 },
  extendBtn: {
    flex: 1, backgroundColor: C.bg, borderRadius: 16,
    paddingVertical: 14, alignItems: 'center',
    borderWidth: 1.5, borderColor: '#DDE8E3',
    minHeight: 60, justifyContent: 'center',
  },
  extendBtnMins: { fontSize: 18, fontWeight: '900', color: C.mint },
  extendBtnLabel: { fontSize: 11, fontWeight: '600', color: C.warmGray, marginTop: 2 },
  readyBtn: {
    marginHorizontal: 20, marginBottom: 28,
    backgroundColor: C.earningsBg, borderRadius: 18,
    paddingVertical: 16, alignItems: 'center',
    shadowColor: C.mint, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 6,
  },
  readyBtnText: { fontSize: 15, fontWeight: '900', color: C.white, letterSpacing: 0.2 },

  // ── Go Live ───────────────────────────────────────────────────────────
  goLiveHeader: {
    backgroundColor: C.earningsBg, paddingHorizontal: 24,
    paddingTop: 28, paddingBottom: 22, overflow: 'hidden', position: 'relative',
  },
  goLiveHeaderBlob: {
    position: 'absolute', width: 130, height: 130, borderRadius: 65,
    backgroundColor: 'rgba(78,189,150,0.18)', top: -50, right: -20,
  },
  goLiveEyebrow: { fontSize: 10, fontWeight: '800', color: C.accentStrong, letterSpacing: 1.4, marginBottom: 8 },
  goLiveTitle: { fontSize: 22, fontWeight: '900', color: C.white, lineHeight: 28, letterSpacing: -0.3 },
  goLiveSub: { fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 6 },
  photoPreviewWrap: { position: 'relative', margin: 20, borderRadius: 20, overflow: 'hidden' },
  photoPreview: { width: '100%', height: 200, borderRadius: 20 },
  photoPreviewBadge: {
    position: 'absolute', bottom: 10, right: 10,
    backgroundColor: 'rgba(30,107,84,0.9)',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
  },
  photoPreviewBadgeText: { color: C.white, fontSize: 12, fontWeight: '800' },
  photoPlaceholder: {
    margin: 20, height: 160, borderRadius: 20,
    backgroundColor: C.bg, borderWidth: 2, borderColor: '#DDE8E3',
    borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  photoPlaceholderEmoji: { fontSize: 40 },
  photoPlaceholderText: { fontSize: 13, color: C.warmGray, fontWeight: '600' },
  photoActions: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, marginBottom: 16 },
  cameraBtn: {
    flex: 1, backgroundColor: C.bg, borderRadius: 16,
    paddingVertical: 16, alignItems: 'center', gap: 6,
    borderWidth: 1.5, borderColor: '#DDE8E3',
  },
  cameraBtnIcon: { fontSize: 28 },
  cameraBtnText: { fontSize: 13, fontWeight: '700', color: C.ink },
  goLiveBtn: {
    marginHorizontal: 20, marginBottom: 12,
    backgroundColor: C.mint, borderRadius: 18,
    paddingVertical: 16, alignItems: 'center',
    shadowColor: C.mint, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 10, elevation: 6,
  },
  goLiveBtnDisabled: { backgroundColor: '#B5CDCA', shadowOpacity: 0 },
  goLiveBtnText: { fontSize: 16, fontWeight: '900', color: C.white, letterSpacing: 0.3 },
  cancelBtn: { alignItems: 'center', paddingVertical: 14, marginBottom: 8 },
  cancelBtnText: { fontSize: 14, color: C.warmGray, fontWeight: '600' },
});

const locSt = StyleSheet.create({
  backdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.28)' },
  sheet:        { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '88%', backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 24 },
  sheetScroll:  { flexGrow: 0 },
  sheetContent: { paddingBottom: 12 },
  handle:       { alignSelf: 'center', width: 42, height: 5, borderRadius: 3, backgroundColor: '#D9D3CB', marginBottom: 12 },
  title:        { fontSize: 20, fontWeight: '800', color: C.ink },
  sub:          { fontSize: 12, color: C.warmGray, marginTop: 4, marginBottom: 16, lineHeight: 18 },
  searchRow:    { flexDirection: 'row', alignItems: 'center', backgroundColor: C.cream, borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: C.border, marginBottom: 12 },
  searchInput:  { flex: 1, fontSize: 14, color: C.ink, paddingVertical: Platform.OS === 'ios' ? 13 : 10 },
  clearBtn:     { fontSize: 14, color: C.warmGray, paddingHorizontal: 6 },
  gpsBtn:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.mintLight, borderRadius: 14, padding: 14, marginBottom: 14 },
  gpsBtnText:   { fontSize: 14, fontWeight: '700', color: C.mintDark },
  gpsBtnSub:    { fontSize: 11, color: C.mintDark, marginTop: 3, maxWidth: SW - 120 },
  gpsBtnIcon:   { fontSize: 20 },
  radiusBox:    { backgroundColor: '#F5F2ED', borderRadius: 12, padding: 14, marginBottom: 14 },
  radiusRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  radiusLabel:  { fontSize: 13, fontWeight: '600', color: C.ink },
  radiusValue:  { fontSize: 15, fontWeight: '800', color: C.mint },
  slider:       { width: '100%', height: 36 },
  radiusTicks:  { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  radiusTick:   { fontSize: 10, color: C.warmGray },
  radiusHint:   { fontSize: 11, color: C.warmGray, marginTop: 6, textAlign: 'center' },
  mapCard:      { backgroundColor: '#F5F2ED', borderRadius: 12, borderWidth: 1, borderColor: C.border, marginBottom: 14 },
  mapCaption:   { paddingHorizontal: 12, paddingVertical: 10 },
  mapCaptionTitle: { fontSize: 13, fontWeight: '800', color: C.ink },
  mapCaptionSub: { fontSize: 11, color: C.warmGray, marginTop: 3 },
  addressCard: { backgroundColor: '#F9F7F2', borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12, marginBottom: 12, gap: 10 },
  addressTitle: { fontSize: 13, fontWeight: '800', color: C.ink },
  fieldInput: { borderWidth: 1, borderColor: '#E4DED2', borderRadius: 12, backgroundColor: C.white, paddingHorizontal: 12, paddingVertical: 11, fontSize: 13, color: C.ink },
  fieldInputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  photoBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#E4DED2', borderRadius: 12, backgroundColor: C.white, padding: 10 },
  photoPlaceholder: { width: 56, height: 56, borderRadius: 14, backgroundColor: C.paleBlue, alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { fontSize: 12, fontWeight: '800', color: C.mintDark },
  photoPreview: { width: 56, height: 56, borderRadius: 14 },
  photoCopy: { flex: 1 },
  photoTitle: { fontSize: 13, fontWeight: '700', color: C.ink },
  photoSub: { fontSize: 11, color: C.warmGray, marginTop: 2, lineHeight: 16 },
  results:      { maxHeight: 280, marginTop: 4 },
  listItem:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  listItemActive: { backgroundColor: '#F8FBF9' },
  listItemIcon: { fontSize: 18, width: 24, textAlign: 'center' },
  listItemName: { fontSize: 14, fontWeight: '600', color: C.ink },
  listItemNameActive: { color: C.mintDark },
  listItemSub:  { fontSize: 11, color: C.warmGray, marginTop: 2 },
  mapPopupBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  mapPopupSheet: { backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingBottom: 22, paddingTop: 6, minHeight: '68%' },
  mapPopupCard: { borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: C.border, backgroundColor: '#F5F2ED', height: 340, marginBottom: 14 },
  mapPopupFrame: { width: '100%', height: '100%', backgroundColor: '#F5F2ED' },
  fixedPinWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  fixedPinDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#E53E3E', borderWidth: 2, borderColor: C.white, marginTop: -22, shadowColor: 'rgba(0,0,0,0.18)', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
  fixedPinStem: { width: 4, height: 18, backgroundColor: '#1A2620', borderRadius: 2, marginTop: -2 },
  fixedPinTip: { width: 0, height: 0, borderLeftWidth: 7, borderRightWidth: 7, borderTopWidth: 10, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#1A2620', marginTop: -1 },
  mapRadiusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  mapRadiusControls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mapRadiusBtn: { width: 36, height: 36, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: '#F9F7F2', alignItems: 'center', justifyContent: 'center' },
  mapRadiusBtnText: { fontSize: 22, lineHeight: 24, fontWeight: '700', color: C.ink },
  mapRadiusValuePill: { minWidth: 72, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: C.paleGreen, alignItems: 'center' },
  mapRadiusValueText: { fontSize: 12, fontWeight: '800', color: C.mintDark },
  mapCoordsRow: { backgroundColor: '#F9F7F2', borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14 },
  mapCoordsLabel: { fontSize: 12, fontWeight: '700', color: C.ink, marginBottom: 4 },
  mapCoordsValue: { fontSize: 12, color: C.mintDark, fontWeight: '700' },
  mapPopupActions: { flexDirection: 'row', gap: 10 },
  mapCancelBtn: { flex: 1, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 14, alignItems: 'center', backgroundColor: '#F9F7F2' },
  mapCancelText: { fontSize: 13, fontWeight: '700', color: C.warmGray },
  mapConfirmBtn: { flex: 1.4, borderRadius: 14, paddingVertical: 14, alignItems: 'center', backgroundColor: C.mint, shadowColor: C.mint, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4 },
  mapConfirmText: { fontSize: 13, fontWeight: '800', color: C.white },
  saveActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  saveSecondaryBtn: { flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: '#F9F7F2' },
  saveSecondaryBtnText: { color: C.ink, fontSize: 14, fontWeight: '700' },
  saveBtn: { flex: 1.4, backgroundColor: C.mint, borderRadius: 14, paddingVertical: 15, alignItems: 'center', shadowColor: C.mint, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4 },
  saveBtnText: { color: C.white, fontSize: 14, fontWeight: '800' },
});

const cardSt = StyleSheet.create({
  reqCard:      { backgroundColor: C.white, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 12, shadowColor: C.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 1 },
  reqTop:       { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  reqEmoji:     { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  reqName:      { fontSize: 15, fontWeight: '700', color: C.ink },
  reqMeta:      { fontSize: 11, color: C.warmGray, marginTop: 2 },
  reqPriceCol:  { alignItems: 'flex-end', minWidth: 78 },
  reqBudget:    { fontSize: 18, fontWeight: '800', color: C.mint, textAlign: 'right' },
  reqBudgetLabel: { fontSize: 9, color: C.warmGray, textTransform: 'uppercase', textAlign: 'right' },
  reqNegotiated: { fontSize: 14, fontWeight: '800', color: C.spice, textAlign: 'right', marginTop: 4 },
  reqNegotiatedLabel: { fontSize: 9, color: C.warmGray, textTransform: 'uppercase', textAlign: 'right' },
  reqBottom:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  reqRight:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reqTime:      { fontSize: 11, color: C.warmGray },
  quotedBadge:  { backgroundColor: C.paleYellow, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  quotedBadgeText: { fontSize: 10, fontWeight: '700', color: '#B07800' },
  quoteBtn:     { backgroundColor: C.mint, borderRadius: 10, paddingVertical: 10, alignItems: 'center', shadowColor: C.mint, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 2 },
  quoteBtnText: { color: C.white, fontSize: 13, fontWeight: '700' },
  outOfRangeBanner: { backgroundColor: '#FFF8E7', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 8, borderWidth: 1, borderColor: '#F0D080' },
  outOfRangeText: { fontSize: 12, color: '#A07000', fontWeight: '600' },
  outOfRangeActions: { flexDirection: 'row', gap: 8 },
  acceptAnywayBtn: { flex: 1, backgroundColor: C.mint, borderRadius: 10, paddingVertical: 9, alignItems: 'center' },
  acceptAnywayText: { color: C.white, fontSize: 13, fontWeight: '700' },
  ignoreBtn: { flex: 1, backgroundColor: '#FFF0F0', borderRadius: 10, paddingVertical: 9, alignItems: 'center', borderWidth: 1, borderColor: '#F0C0C0' },
  ignoreBtnText: { color: '#C03030', fontSize: 13, fontWeight: '700' },
  orderCard:    { backgroundColor: C.white, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12, marginBottom: 10 },
  orderTop:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orderEmoji:   { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  orderName:    { fontSize: 14, fontWeight: '700', color: C.ink },
  orderBuyer:   { fontSize: 11, color: C.warmGray, marginTop: 2 },
  orderTime:    { fontSize: 10, color: C.warmGray, marginTop: 2 },
  statusBadge:  { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  statusText:   { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  nextAction:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
  nextActionText:{ fontSize: 12, fontWeight: '700' },
  nextActionArrow:{ fontSize: 18, fontWeight: '700' },
  reviewRow:    { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
  reviewText:   { fontSize: 11, color: C.warmGray, flex: 1 },
});

const mpSt = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(15, 12, 9, 0.55)', justifyContent: 'center', padding: 18 },
  card: { maxHeight: '82%', backgroundColor: C.white, borderRadius: 24, padding: 18 },
  title: { fontSize: 22, fontWeight: '900', color: C.ink },
  sub: { fontSize: 13, color: C.warmGray, lineHeight: 19, marginTop: 6, marginBottom: 16 },
  label: { fontSize: 10, fontWeight: '800', color: C.warmGray, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  cityInput: {
    backgroundColor: C.bg, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: C.ink, marginBottom: 14,
  },
  list: { maxHeight: 380 },
  listContent: { gap: 10 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    backgroundColor: C.bg, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 12,
  },
  rowCopy: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '800', color: C.ink },
  rowMeta: { fontSize: 11, color: C.warmGray, marginTop: 2, textTransform: 'capitalize' },
  priceBox: {
    minWidth: 118, flexDirection: 'row', alignItems: 'center', backgroundColor: C.white,
    borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10,
  },
  currency: { fontSize: 18, fontWeight: '800', color: C.ink, marginRight: 6 },
  priceInput: { flex: 1, fontSize: 15, fontWeight: '700', color: C.ink, paddingVertical: Platform.OS === 'ios' ? 10 : 8 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  skipBtn: { flex: 1, backgroundColor: C.bg, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 14, alignItems: 'center' },
  skipText: { fontSize: 14, fontWeight: '700', color: C.warmGray },
  saveBtn: { flex: 1.2, backgroundColor: C.mint, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  saveText: { fontSize: 14, fontWeight: '800', color: C.white },
});

const offerSt = StyleSheet.create({
  card: {
    backgroundColor: C.white, borderRadius: 16,
    borderWidth: 1, borderColor: C.border,
    padding: 14, marginBottom: 12,
    shadowColor: C.ink, shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 6, elevation: 1,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  emojiWrap: {
    width: 46, height: 46, borderRadius: 12,
    backgroundColor: C.paleGreen, alignItems: 'center', justifyContent: 'center',
  },
  emoji: { fontSize: 26 },
  dishName: { fontSize: 15, fontWeight: '700', color: C.ink },
  buyerLine: { fontSize: 11, color: C.warmGray, marginTop: 2 },
  exactPricePill: { alignSelf: 'flex-start', marginTop: 6, backgroundColor: C.paleYellow, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: '#F4D98B' },
  exactPriceText: { fontSize: 10, fontWeight: '800', color: '#B07800', letterSpacing: 0.3 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  statusText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  infoRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  infoChip: {
    flex: 1, backgroundColor: C.bg, borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 10, alignItems: 'center',
  },
  infoLabel: { fontSize: 9, fontWeight: '700', color: C.warmGray, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  infoValue: { fontSize: 14, fontWeight: '800', color: C.ink },
  counterBanner: {
    backgroundColor: '#FFF3ED', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8,
    borderLeftWidth: 3, borderLeftColor: C.spice,
  },
  counterBannerMuted: { backgroundColor: C.paleGreen, borderLeftColor: C.mint },
  counterBannerText: { fontSize: 12, color: C.spice, fontWeight: '600' },
  counterBannerTextMuted: { color: C.mintDark },
  message: { fontSize: 13, color: C.warmGray, fontStyle: 'italic', marginBottom: 10 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  actionBtn: { flex: 1, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
  actionReject: { backgroundColor: C.paleRed, borderWidth: 1, borderColor: '#F5C0C0' },
  actionRejectText: { fontSize: 13, fontWeight: '700', color: C.red },
  actionCounter: { backgroundColor: C.paleYellow, borderWidth: 1, borderColor: '#F4D98B' },
  actionCounterText: { fontSize: 13, fontWeight: '700', color: '#B07800' },
  actionAccept: { backgroundColor: C.mintLight, borderWidth: 1, borderColor: C.accentStrong },
  actionAcceptWide: { flex: 2 },
  actionAcceptText: { fontSize: 13, fontWeight: '700', color: C.mintDark },

  // Counter modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  sheet: { backgroundColor: C.white, borderRadius: 24, padding: 24, width: '100%' },
  sheetTitle: { fontSize: 20, fontWeight: '900', color: C.ink, marginBottom: 4 },
  sheetSub: { fontSize: 13, color: C.warmGray, marginBottom: 18, lineHeight: 18 },
  fieldLabel: { fontSize: 10, fontWeight: '800', color: C.warmGray, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, marginTop: 14 },
  input: {
    backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: C.ink,
  },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 22 },
  btn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  btnCancel: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  btnCancelText: { fontSize: 14, fontWeight: '700', color: C.warmGray },
  btnSend: { backgroundColor: C.spice },
  btnSendText: { fontSize: 14, fontWeight: '800', color: C.white },
  lastCounterBanner: {
    backgroundColor: C.paleYellow, borderRadius: 12, padding: 12,
    marginBottom: 14, borderLeftWidth: 3, borderLeftColor: C.turmeric,
  },
  lastCounterLabel: { fontSize: 9, fontWeight: '800', color: '#B07800', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 2 },
  lastCounterValue: { fontSize: 20, fontWeight: '900', color: C.ink, marginBottom: 2 },
  lastCounterHint: { fontSize: 11, color: C.warmGray },
  inputError: { borderColor: C.red, borderWidth: 1.5 },
  errorText: { fontSize: 11, color: C.red, marginTop: 4, marginBottom: 2 },
});
