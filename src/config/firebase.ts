import admin from "firebase-admin";
import { env } from "./env";
import { logger } from "@/common/utils/logger";

let initialized = false;

export function getFirebase(): typeof admin | null {
  if (initialized) return admin;
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    logger.warn("Firebase credentials missing — SMS OTP and Push will run in stub mode");
    return null;
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
  initialized = true;
  logger.info("Firebase Admin initialised");
  return admin;
}
