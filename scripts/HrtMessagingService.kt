package com.kiramyao.hrt
import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class HrtMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        if (data["kind"] != "dose_overdue") return

        val zone = data["zone"]
        if (!zone.isNullOrEmpty() && HrtMedAlarmReceiver.zone() != zone) return
        val planId = data["planId"] ?: return
        val dueAt = data["dueAt"] ?: return
        val prefs = getSharedPreferences(MainActivity.NOTIF_PREFS, Context.MODE_PRIVATE)
        val revisions = org.json.JSONObject(prefs.getString(MainActivity.NOTIF_PLANS_KEY, "{}") ?: "{}")
        val expected = revisions.optJSONObject(planId)?.optString("revision")
        if (data["revision"] != null && data["revision"] != expected) return
        HrtDoseReminder.showDoseReminder(this, planId, dueAt)
    }

}
