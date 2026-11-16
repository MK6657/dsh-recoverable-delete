"""Per-child Windows sandbox temp compatibility, never installed globally.

Python's owner-only mkdir(mode=0o700) DACL can remove the restricted write SID
that the Windows runner needs, so a process cannot enter its own new temp dir.
Only new children of the broker-created disposable root inherit its existing
ACL. Other paths/modes and the native sandbox policy are unchanged.
"""
import os
import sys
import tempfile
import importlib.machinery
import importlib.util

_root = os.environ.get('DSH_RECOVERY_PY_TEMP')
if os.name == 'nt' and _root and os.path.isabs(_root) and os.path.isdir(_root):
    _root = os.path.normcase(os.path.realpath(_root))
    _mkdir = os.mkdir

    def _temporary_mkdir(name, mode=0o777, *, dir_fd=None):
        if mode == 0o700 and dir_fd is None:
            try:
                target = os.path.normcase(os.path.abspath(os.fsdecode(name)))
                parent = os.path.normcase(os.path.realpath(os.path.dirname(target)))
                if target != _root and os.path.commonpath([_root, target]) == _root and os.path.commonpath([_root, parent]) == _root:
                    mode = 0o777  # inherit the already granted, bounded ACL
            except (ValueError, TypeError, OSError):
                pass
        return _mkdir(name, mode, dir_fd=dir_fd)

    os.mkdir = _temporary_mkdir
    tempfile.tempdir = _root

# Preserve an existing sitecustomize from the caller's normal search path.
_here = os.path.normcase(os.path.realpath(os.path.dirname(__file__)))
_search = [p for p in sys.path if os.path.normcase(os.path.realpath(p or os.getcwd())) != _here]
_spec = importlib.machinery.PathFinder.find_spec('sitecustomize', _search)
if _spec and _spec.origin and os.path.normcase(os.path.realpath(_spec.origin)) != os.path.normcase(os.path.realpath(__file__)):
    _other = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_other)
