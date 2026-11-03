const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =================================================================
// ১. ফায়ারবেস অ্যাডমিন ইনিশিয়ালাইজেশন
// (Render Environment Variables অথবা সরাসরি JSON কোড দেওয়া যাবে)
// =================================================================
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    // লোকাল টেস্টের জন্য এখানে JSON ফাইল পাথ বা অবজেক্ট দিতে পারেন
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (err) {
        console.error("Firebase Service Account পাওয়া যায়নি! Render এর Environment Variables এ দিন।");
    }
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore ? admin.firestore() : null;
const ADMIN_KEY = process.env.ADMIN_KEY || "AyPush@2026"; // আপনার অ্যাডমিন সিক্রেট পাসওয়ার্ড
const VAPID_KEY = process.env.VAPID_KEY || "";             // আপনার ফায়ারবেসের VAPID Key

// =================================================================
// ২. ক্লায়েন্ট কনফিগারেশন পাওয়ার API
// =================================================================
app.get('/api/config', (req, res) => {
    res.json({
        ok: true,
        vapidKey: VAPID_KEY,
        projectId: serviceAccount ? serviceAccount.project_id : ""
    });
});

// =================================================================
// ৩. যেকোনো সফটওয়্যার থেকে ডিভাইস টোকেন সেভ করার API
// =================================================================
app.post('/api/register', async (req, res) => {
    try {
        const { token, appId, userId, platform } = req.body;
        if (!token || !appId) {
            return res.status(400).json({ ok: false, error: "token ও appId আবশ্যক।" });
        }

        const docId = `${appId}_${token.slice(-20)}`;
        await db.collection('ay_devices').doc(docId).set({
            token: String(token).trim(),
            appId: String(appId).trim(),
            userId: userId ? String(userId).trim() : 'guest',
            platform: platform || 'web',
            updatedAt: Date.now()
        }, { merge: true });

        res.json({ ok: true, message: "ডিভাইস রেজিস্টার সম্পন্ন হয়েছে।" });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// =================================================================
// ৪. কেন্দ্রীয় পুশ পাঠানোর API (invalid-argument সম্পূর্ণ ফিক্সড)
// =================================================================
app.post('/api/send', async (req, res) => {
    const authHeader = req.headers['x-admin-key'];
    if (authHeader !== ADMIN_KEY) {
        return res.status(401).json({ ok: false, error: "অননুমোদিত অ্যাক্সেস (ভুল অ্যাডমিন চাবি)" });
    }

    try {
        const { appId, userId, title, body, link, data } = req.body;

        // টার্গেট ডিভাইস খোঁজা
        let query = db.collection('ay_devices');
        if (appId && appId !== 'all') {
            query = query.where('appId', '==', String(appId));
        }
        if (userId && userId !== 'all') {
            query = query.where('userId', '==', String(userId));
        }

        const snapshot = await query.get();
        if (snapshot.empty) {
            return res.json({ ok: false, message: "কোনো টার্গেট ডিভাইস পাওয়া যায়নি।" });
        }

        const tokens = [];
        const docIds = [];
        snapshot.forEach(doc => {
            tokens.push(doc.data().token);
            docIds.push(doc.id);
        });

        // ═════════════════════════════════════════════════════════════
        // 🔥 INVALID-ARGUMENT এরর প্রতিরোধের আসল ম্যাজিক:
        // ১. data এর প্রতিটি Key এবং Value কে নিশ্চিতভাবে String বানানো।
        // ২. খালি link থাকলে বাদ দেওয়া।
        // ═════════════════════════════════════════════════════════════
        const cleanData = {};
        if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
                cleanData[String(k)] = String(v ?? '');
            }
        }
        cleanData["click_action"] = String(link || '');
        cleanData["sent_time"] = String(Date.now());
        cleanData["app_id"] = String(appId || 'all');

        const messagePayload = {
            notification: {
                title: String(title || "বিজ্ঞপ্তি"),
                body: String(body || "")
            },
            data: cleanData
        };

        // লিংক থাকলে তবেই webpush এর fcmOptions দেওয়া হবে
        if (link && String(link).trim() !== '') {
            messagePayload.webpush = {
                fcmOptions: {
                    link: String(link).trim()
                }
            };
        }

        // ব্যাচ আকারে পাঠানো (প্রতি ব্যাচে সর্বোচ্চ ৫০০টি টোকেন)
        let totalSuccess = 0;
        let totalFailed = 0;
        const invalidTokensToDelete = [];

        for (let i = 0; i < tokens.length; i += 500) {
            const batchTokens = tokens.slice(i, i + 500);
            const batchDocIds = docIds.slice(i, i + 500);

            const multicastPayload = {
                ...messagePayload,
                tokens: batchTokens
            };

            const response = await admin.messaging().sendEachForMulticast(multicastPayload);
            totalSuccess += response.successCount;
            totalFailed += response.failureCount;

            // নষ্ট বা আনইন্সটল হওয়া টোকেন শনাক্ত করে ডাটাবেস থেকে মুছে ফেলা
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const errCode = resp.error ? resp.error.code : '';
                    if (
                        errCode === 'messaging/registration-token-not-registered' ||
                        errCode === 'messaging/invalid-registration-token'
                    ) {
                        invalidTokensToDelete.push(batchDocIds[idx]);
                    }
                }
            });
        }

        // ডাটাবেস ক্লিনআপ
        if (invalidTokensToDelete.length > 0) {
            const batch = db.batch();
            invalidTokensToDelete.forEach(id => {
                batch.delete(db.collection('ay_devices').doc(id));
            });
            await batch.commit().catch(() => {});
        }

        res.json({
            ok: true,
            total: tokens.length,
            success: totalSuccess,
            failed: totalFailed,
            cleaned: invalidTokensToDelete.length
        });

    } catch (e) {
        console.error("পুশ ত্রুটি:", e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// =================================================================
// ৫. ইউনিভার্সাল ক্লায়েন্ট লাইব্রেরি তৈরি (/ay-push.js)
// এটি যেকোনো ওয়েবসাইট বা সফটওয়্যারে লোড করলেই পুশ রেডি হয়ে যাবে
// =================================================================
app.get('/ay-push.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
(function() {
    window.AyPush = {
        async init(config) {
            const server = (config.server || "").replace(/\\/+$/, "");
            const appId = config.appId || "default_app";
            const userId = config.userId || "guest";
            const swPath = config.swPath || "/firebase-messaging-sw.js";

            if (!("Notification" in window) || !("serviceWorker" in navigator)) {
                console.warn("[AyPush] ব্রাউজারে নোটিফিকেশন সাপোর্ট নেই।");
                return false;
            }

            try {
                // সার্ভার থেকে VAPID কি আনা
                const cfgRes = await fetch(server + "/api/config").then(r => r.json());
                if (!cfgRes.ok || !cfgRes.vapidKey) throw new Error("সার্ভার কনফিগারেশন ত্রুটি।");

                // পারমিশন চাওয়া
                const perm = await Notification.requestPermission();
                if (perm !== "granted") return false;

                // সার্ভিস ওয়ার্কার রেজিস্টার
                const reg = await navigator.serviceWorker.register(swPath);
                await navigator.serviceWorker.ready;

                // ফায়ারবেস স্ক্রিপ্ট লোড (যদি আগে না থাকে)
                if (!window.firebase || !window.firebase.messaging) {
                    await new Promise(res => {
                        const s = document.createElement("script");
                        s.src = "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js";
                        s.onload = () => {
                            const s2 = document.createElement("script");
                            s2.src = "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js";
                            s2.onload = res;
                            document.head.appendChild(s2);
                        };
                        document.head.appendChild(s);
                    });
                }

                if (!firebase.apps.length) {
                    firebase.initializeApp({ projectId: cfgRes.projectId, messagingSenderId: cfgRes.projectId });
                }

                const messaging = firebase.messaging();
                const currentToken = await messaging.getToken({
                    vapidKey: cfgRes.vapidKey,
                    serviceWorkerRegistration: reg
                });

                if (currentToken) {
                    // কেন্দ্রীয় সার্ভারে টোকেন পাঠানো
                    await fetch(server + "/api/register", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ token: currentToken, appId, userId, platform: "web" })
                    });
                    console.log("[AyPush] ডিভাইস সংযুক্ত হয়েছে!");

                    // ফোরগ্রাউন্ড মেসেজ রিসিভার
                    messaging.onMessage((payload) => {
                        if (config.onMessage) config.onMessage(payload.notification || payload.data);
                    });
                    return true;
                }
            } catch (err) {
                console.error("[AyPush] ইনিট ত্রুটি:", err);
            }
            return false;
        }
    };
})();
    `);
});

// হেলথ চেক ও হোম
app.get('/', (req, res) => {
    res.send(`<h2>🚀 Ay Push Server রানিং আছে</h2><p>কানেক্টেড প্রজেক্ট: ${serviceAccount ? serviceAccount.project_id : 'নেই'}</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ay Push Server চলছে পোর্ট: ${PORT}`));