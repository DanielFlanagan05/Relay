"""No inference: verify runtime arguments and weight-once budgeting with a fake controller."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).resolve().parents[1] / 'electron/localai_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeController:
    def profiles(self):
        return {'large': {'engine': 'kyojin-qwen', 'sessions': 1, 'estimated_gib': 105}}

    def engine_command(self, name, settings):
        return ['python', 'serve.py']

    def memory(self):
        return {'unified_available_bytes': 200 * bridge.GIB}


class GufoController(FakeController):
    def profiles(self):
        return {'flash': {'engine': 'gufo', 'sessions': 1, 'cache_gib': 12,
                          'estimated_gib': 103, 'minimum_free_gib': 8}}


class BridgeTests(unittest.TestCase):
    def test_shared_large_model_gets_real_parallel_runtime_slots(self):
        controller = FakeController()
        bridge.configure(controller, 'large', 3, 4)
        settings = controller.profiles()['large']
        self.assertEqual(settings['sessions'], 3)
        self.assertEqual(settings['estimated_gib'], 113)  # one 105 GiB footprint, two extra 4 GiB caches
        self.assertEqual(controller.engine_command('large', settings)[-2:], ['--sessions', '3'])

    def test_reserve_override_is_explicit_and_validated(self):
        controller = FakeController()
        bridge.configure(controller, 'large', 3, 4, 6)
        self.assertEqual(controller.profiles()['large']['minimum_free_gib'], 6)
        self.assertEqual(controller.profiles()['large']['estimated_gib'], 113)
        for invalid in [1, 129, float('nan')]:
            with self.assertRaises(ValueError):
                bridge.configure(FakeController(), 'large', 3, 4, invalid)

    def test_gufo_ram_cache_fits_launch_headroom(self):
        # 91 GiB base + 8 reserve + 1 drift leaves 6 GiB of cache at 106 available.
        controller = GufoController()
        bridge.configure(controller, 'flash', 1, 4, available_gib=106)
        settings = controller.profiles()['flash']
        self.assertEqual((settings['cache_gib'], settings['estimated_gib']), (6, 97))

    def test_gufo_ram_cache_keeps_profile_size_with_room_and_a_floor_without(self):
        roomy = GufoController()
        bridge.configure(roomy, 'flash', 1, 4, available_gib=120)
        self.assertEqual(roomy.profiles()['flash']['cache_gib'], 12)
        tight = GufoController()
        bridge.configure(tight, 'flash', 1, 4, available_gib=95)
        self.assertEqual(tight.profiles()['flash']['cache_gib'], bridge.MIN_CACHE_GIB)

    def test_non_gufo_profiles_keep_their_cache(self):
        controller = FakeController()
        bridge.configure(controller, 'large', 1, 4, available_gib=50)
        self.assertNotIn('cache_gib', controller.profiles()['large'])


if __name__ == '__main__':
    unittest.main()
