"""Run one shared LocalAi runtime with app-selected concurrency, without editing its profiles.

Keeps the controller's process ownership, memory supervision, log and state conventions.
The renderer never executes this script directly.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import sys


def configure(controller, profile_name, sessions, slot_gib, reserve_gib=None):
    if reserve_gib is not None and not 2 <= reserve_gib <= 128:
        raise ValueError('Invalid system memory reserve')
    original_profiles = controller.profiles
    profile = dict(original_profiles()[profile_name])
    baseline = profile.get('sessions', 1)
    profile['sessions'] = sessions
    if reserve_gib is not None:
        profile['minimum_free_gib'] = reserve_gib
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
    # Electron leaks non-CLOEXEC descriptors (e.g. the DevTools listening socket)
    # into this detached child, which would keep the port bound after Relay quits.
    os.closerange(3, os.sysconf('SC_OPEN_MAX'))
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--sessions', type=int, required=True)
    parser.add_argument('--slot-gib', type=float, required=True)
    parser.add_argument('--reserve-gib', type=float)
    args = parser.parse_args()
    if not 1 <= args.sessions <= 16 or not 0.25 <= args.slot_gib <= 128:
        parser.error('Invalid session/memory limits')
    source = Path(args.root).resolve() / 'scripts/linux/localai.py'
    spec = importlib.util.spec_from_file_location('localai_controller', source)
    controller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controller)
    if controller.running(args.profile):
        raise RuntimeError('An existing inference runtime owns this slot. Reuse it or stop it before resizing.')
    configure(controller, args.profile, args.sessions, args.slot_gib, args.reserve_gib)
    return controller.serve(args.profile)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f'Relay runtime: {error}', file=sys.stderr, flush=True)
        sys.exit(1)
