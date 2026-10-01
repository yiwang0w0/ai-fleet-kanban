import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("health_watch", pathlib.Path(__file__).parents[1] / "watchers" / "board_health_watch.py")
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)

def snapshot(code=None, seed="a", count=1):
    issues = [] if code is None else [dict(code=code, level=watch.FLEET_MESSAGES[code][0], fingerprint=seed * 64, count=count, sample_ids=["12345678-1234-4123-8123-123456789abc"], next_action="ignored")]
    return dict(format="ai-fleet-health/v2", modules=dict(broker="available", delivery="available", scheduler="available", node_runtime="available"), state_changes=False, executor_stop_confirmed=False, remote_state="not_queried", issues=issues)

class FleetHealthWatchTests(unittest.TestCase):
    def test_every_code_uses_fixed_local_text_and_severity(self):
        for code, (level, _) in watch.FLEET_MESSAGES.items():
            v = snapshot(code)
            v["issues"][0]["message"] = "PRIVATE-RAW-TOKEN"
            result = watch.fleet_health_signals(v)
            self.assertEqual(bool(result[0]), level == "problem")
            self.assertEqual(bool(result[1]), level == "notice")
            self.assertNotIn("PRIVATE", str(result))

    def test_retry_is_notice_and_interrupted_is_problem(self):
        self.assertFalse(watch.fleet_health_signals(snapshot("DELIVERY_RETRY_PENDING"))[0])
        self.assertTrue(watch.fleet_health_signals(snapshot("BROKER_INTERRUPTED"))[0])

    def test_same_issue_age_and_retry_attempts_do_not_reset_throttle(self):
        alarm = watch.AlarmThrottle()
        results = []
        for age in range(9):
            v = snapshot("DELIVERY_BLOCKED")
            v["checked_at"] = age
            v["issues"][0]["attempts"] = age
            p, _, keys, _ = watch.fleet_health_signals(v)
            results.append(alarm.tick(str([p, keys]))[0])
        self.assertEqual(results, ["report", "report", "quiet", "report", "quiet", "quiet", "quiet", "report", "quiet"])

    def test_changed_hidden_ids_are_not_suppressed(self):
        alarm = watch.AlarmThrottle()
        alarm.tick(str(watch.fleet_health_signals(snapshot("DELIVERY_BLOCKED", "a"))[2]))
        self.assertEqual(alarm.tick(str(watch.fleet_health_signals(snapshot("DELIVERY_BLOCKED", "b"))[2]))[0], "report")

    def test_valid_empty_observation_clears_only_once(self):
        alarm = watch.AlarmThrottle()
        alarm.tick("problem")
        self.assertEqual(watch.fleet_health_signals(snapshot()), ([], [], [], []))
        self.assertEqual(alarm.tick("")[0], "clear")
        self.assertEqual(alarm.tick("")[0], "quiet")

    def test_unknown_or_incomplete_responses_do_not_clear(self):
        bad = [{}, snapshot("DELIVERY_BLOCKED"), snapshot(), snapshot()]
        bad[1]["issues"][0]["code"] = "FUTURE_PRIVATE_CODE"
        bad[2]["modules"].pop("scheduler")
        bad[3]["issues"] = None
        for value in bad:
            result = watch.probe_fleet_health(lambda _: value)
            self.assertTrue(result[0])
            self.assertEqual(result[2], ["FLEET_HEALTH_UNAVAILABLE"])

    def test_old_or_missing_node_coverage_cannot_clear_runtime_alarm(self):
        for missing in (True, False):
            value = snapshot()
            if missing:
                value["modules"].pop("node_runtime")
            else:
                value["format"] = "ai-fleet-health/v1"
            self.assertEqual(watch.probe_fleet_health(lambda _: value)[2], ["FLEET_HEALTH_UNAVAILABLE"])

    def test_node_retry_recovers_once_without_repeating_unchanged_observations(self):
        throttle = watch.AlarmThrottle()
        issue = str(watch.fleet_health_signals(snapshot("NODE_SYNC_RETRY"))[3])
        self.assertEqual([throttle.tick(issue)[0] for _ in range(3)], ["report", "report", "quiet"])
        self.assertEqual(throttle.tick(None)[0], "clear")
        self.assertEqual(throttle.tick(None)[0], "quiet")

    def test_fetch_failures_are_sanitized_and_keep_alarm(self):
        def fetch(_):
            raise OSError("PRIVATE-PATH-TOKEN")
        result = watch.probe_fleet_health(fetch)
        self.assertTrue(result[0])
        self.assertNotIn("PRIVATE", str(result))

    def test_probe_calls_only_the_local_health_endpoint(self):
        calls = []
        def fetch(path):
            calls.append(path)
            return snapshot()
        self.assertEqual(watch.probe_fleet_health(fetch), ([], [], [], []))
        self.assertEqual(calls, ["/api/fleet/health"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
