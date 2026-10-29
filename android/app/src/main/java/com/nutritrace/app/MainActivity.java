package com.nutritrace.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** The app's own links: nutritrace://new/<kind> from the app icon's shortcuts. */
    static final String LINK_SCHEME = "nutritrace";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Reopened from Recents, a shortcut's link that started the app is not
        // a new tap: drop it before the bridge reads the launch URL.
        AppShortcutActivity.dropReplayedLink(this, savedInstanceState);
        // Custom plugins must be registered BEFORE super.onCreate so the
        // bridge picks them up when it builds its plugin handle map.
        registerPlugin(FoldPlugin.class);
        registerPlugin(HealthBackgroundPlugin.class);
        super.onCreate(savedInstanceState);
        // Enqueue/cancel periodic background workers based on current settings.
        // Reminder worker is always enqueued (it gates per-type internally).
        // HC sync worker only runs when healthConnectEnabled = true.
        WorkerScheduler.reschedule(getApplicationContext());
    }
}
