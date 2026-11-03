importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ডিফল্ট ডামি ইনিশিয়ালাইজেশন
firebase.initializeApp({
    messagingSenderId: "dummy"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
    const title = (payload.notification && payload.notification.title) || (payload.data && payload.data.title) || 'নতুন বিজ্ঞপ্তি';
    const options = {
        body: (payload.notification && payload.notification.body) || (payload.data && payload.data.body) || '',
        icon: (payload.notification && payload.notification.icon) || '/icon.png',
        data: payload.data || {}
    };

    return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const url = event.notification.data && event.notification.data.click_action;
    if (url) {
        event.waitUntil(clients.openWindow(url));
    }
});
