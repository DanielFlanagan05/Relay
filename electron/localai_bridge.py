"""Run one shared LocalAi runtime with app-selected concurrency, without editing its profiles.

Keeps the controller's process ownership, memory supervision, log and state conventions.
The renderer never executes this script directly.
"""
import argparse
import importlib.util
from pathlib import Path
import sys


def configure(controller, profile_name, sessions, slot_gib):
    original_profiles = controller.profiles
    profile = dict(original_profiles()[profile_name])
    baseline = profile.get('sessions', 1)
    profile['sessions'] = sessions
    # Reserve extra KV/prefill space, while counting model weights only once.
    profile['estimated_gib'] = profile.get('estimated_gib', 0) + max(0, sessions - baseline) * slot_gib
    controller.profiles = lambda: {**original_profiles(), profile_name: profile}
    original_command = controller.engine_command

    def command(name, settings):
        result = original_command(name, settings)
        if settings['engine'] in ('kyojin-qwen', 'kyojin-glm'):
            result += ['--sessions', str(settings['sessions'])]
        elif settings['engine'].startswith('kyojin-') and sessions > 1:
            raise RuntimeError('This Kyojin family has no verified parallel adapter. Use one slot.')
        return result

    controller.engine_command = command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--sessions', type=int, required=True)
    parser.add_argument('--slot-gib', type=float, required=True)
    args = parser.parse_args()
    if not 1 <= args.sessions <= 16 or not 0.25 <= args.slot_gib <= 128:
        parser.error('Invalid session/memory limits')
    source = Path(args.root).resolve() / 'scripts/linux/localai.py'
    spec = importlib.util.spec_from_file_location('localai_controller', source)
    controller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controller)
    if controller.running(args.profile):
        raise RuntimeError('An existing inference runtime owns this slot. Reuse it or stop it before resizing.')
    configure(controller, args.profile, args.sessions, args.slot_gib)
    return controller.serve(args.profile)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f'Relay runtime: {error}', file=sys.stderr, flush=True)
        sys.exit(1)
