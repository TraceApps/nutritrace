package com.nutritrace.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Enqueue/cancel periodic background workers based on current settings.
        // Reminder worker is always enqueued (it gates per-type internally).
        // HC sync worker only runs when healthConnectEnabled = true.
        WorkerScheduler.reschedule(getApplicationContext());
    }
}
