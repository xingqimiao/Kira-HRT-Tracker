package com.kiramyao.hrt

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

class HrtMedAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        deliver(context, intent)
    }

    companion object {
        private const val QUEUE = "med-alarm-queue"
        private const val EXACT = "med-alarm-exact"
        private const val ZONE = "med-alarm-zone"
        private const val GENERATION = "med-alarm-zone-generation"

        fun zone(): String {
            val raw = TimeZone.getDefault().id
            val id = android.icu.util.TimeZone.getCanonicalID(raw) ?: raw
            return if (id in setOf("Etc/UTC", "Etc/GMT") || !id.contains('/')) "UTC" else id
        }

        private fun prefs(context: Context) = context.getSharedPreferences(MainActivity.NOTIF_PREFS, Context.MODE_PRIVATE)

        private fun pending(context: Context, key: String, identity: String): PendingIntent {
            val intent = Intent(context, HrtMedAlarmReceiver::class.java)
                .setData(Uri.Builder().scheme("hrt-alarm").authority("slot").appendPath(key).build())
                .putExtra("identity", identity)
            return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        @Synchronized fun invalidateOldZone(context: Context) {
            val current = zone()
            val storage = prefs(context)
            if (storage.getString(ZONE, null) == current) return
            val old = JSONObject(storage.getString(QUEUE, "{}") ?: "{}")
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val stale = old.keys().asSequence().filter {
                val zone = old.getJSONObject(it).optString("zone")
                zone.isNotEmpty() && zone != current
            }.toList()
            for (key in stale) {
                alarms.cancel(pending(context, key, ""))
                old.remove(key)
            }
            storage.edit().putString(QUEUE, old.toString()).putString(ZONE, current)
                .putLong(GENERATION, storage.getLong(GENERATION, 0L) + 1L).commit()
        }

        @Synchronized fun generation(context: Context): String {
            invalidateOldZone(context)
            return prefs(context).getLong(GENERATION, 0L).toString()
        }

        @Synchronized fun replaceQueue(context: Context, requestedZone: String, expectedGeneration: String, encoded: String): Boolean {
            if (expectedGeneration != generation(context) || requestedZone != zone()) return false
            val storage = prefs(context)
            val old = JSONObject(storage.getString(QUEUE, "{}") ?: "{}")
            val input = JSONArray(encoded)
            val next = JSONObject()
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()
            val exactChanged = exact != storage.getBoolean(EXACT, false)
            for (index in 0 until input.length()) {
                val slot = input.getJSONObject(index)
                if (slot.optString("zone").isNotEmpty()) {
                    slot.put("identity", slot.getString("identity") + ":" + expectedGeneration)
                }
                if (slot.getLong("dueAt") > System.currentTimeMillis()) next.put(slot.getString("key"), slot)
            }
            val cancel = old.keys().asSequence().filter { !next.has(it) }.toList()
            val install = next.keys().asSequence().filter { exactChanged || old.optString(it) != next.optString(it) }.toList()
            if (cancel.isEmpty() && install.isEmpty()) return true
            for (key in cancel) alarms.cancel(pending(context, key, ""))
            for (key in install) {
                val slot = next.getJSONObject(key)
                val due = slot.getLong("dueAt")
                val alarm = pending(context, key, slot.getString("identity"))
                try {
                    if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, alarm)
                    else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, alarm)
                } catch (_: SecurityException) {
                    alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, alarm)
                }
            }
            return storage.edit().putString(QUEUE, next.toString()).putBoolean(EXACT, exact).commit()
        }

        @Synchronized private fun deliver(context: Context, intent: Intent) {
            invalidateOldZone(context)
            val key = intent.data?.lastPathSegment ?: return
            val storage = prefs(context)
            val queue = JSONObject(storage.getString(QUEUE, "{}") ?: "{}")
            val slot = queue.optJSONObject(key) ?: return
            if (slot.getString("identity") != intent.getStringExtra("identity")) return
            val scheduledZone = slot.optString("zone")
            if (scheduledZone.isNotEmpty() && scheduledZone != zone()) return
            val due = slot.getLong("dueAt")
            queue.remove(key)
            storage.edit().putString(QUEUE, queue.toString()).commit()
            HrtDoseReminder.showDoseReminder(context, slot.getString("planId"), due.toString())
        }
    }
}
