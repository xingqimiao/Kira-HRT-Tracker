import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';

/**
 * Firebase web config, for FCM web push.
 *
 * These values are public by design (they ship in every Firebase web app's bundle and
 * only identify the project); the secret that actually authorises sending lives on the
 * server as a service-account key, never here.
 *
 * Analytics is deliberately NOT initialised. This app promises its records stay on the
 * device unless the user signs in, and that no third-party request rides along on a page
 * load — Analytics would break both (it reports continuously, not on an opt-in action).
 * FCM web messaging is different: it only runs after the user enables notifications, so
 * it is the one Firebase product that fits the app's own consent model. When web push is
 * wired up, request the VAPID key from the console and use it here.
 */
export const firebaseConfig = {
    apiKey: 'AIzaSyApHC5hhx5N81fBGGQrVYKxG50DCiK3A9M',
    authDomain: 'hrt-kiramyao.firebaseapp.com',
    projectId: 'hrt-kiramyao',
    storageBucket: 'hrt-kiramyao.firebasestorage.app',
    messagingSenderId: '890474328321',
    appId: '1:890474328321:web:746b8d7cff4dc4d02d6b00',
} as const;

/** The one Firebase app instance, created on first use and reused after. */
export function getFirebaseApp(): FirebaseApp {
    return getApps().length ? getApp() : initializeApp(firebaseConfig);
}
