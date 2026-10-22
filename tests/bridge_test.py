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


class BridgeTests(unittest.TestCase):
    def test_shared_large_model_gets_real_parallel_runtime_slots(self):
        controller = FakeController()
        bridge.configure(controller, 'large', 3, 4)
        settings = controller.profiles()['large']
        self.assertEqual(settings['sessions'], 3)
        self.assertEqual(settings['estimated_gib'], 113)  # one 105 GiB footprint, two extra 4 GiB caches
        self.assertEqual(controller.engine_command('large', settings)[-2:], ['--sessions', '3'])


if __name__ == '__main__':
    unittest.main()
