"""Read GNU Make/GCC dependency files for the explicitly linked Native targets."""
import hashlib
import pathlib
import shlex


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect_dependencies(source, build, targets):
    source, build = pathlib.Path(source).resolve(), pathlib.Path(build).resolve()
    records, source_hashes, outputs, visited = {}, {}, {}, set()

    def inspect(target, output):
        if target in visited:
            return
        visited.add(target)
        directory = build / 'CMakeFiles' / (target + '.dir')
        link = directory / 'link.txt'
        if not link.is_file():
            raise ValueError('Missing target link command: ' + str(link))
        if not output.is_file():
            raise ValueError('Missing linked output: ' + str(output))
        outputs[str(output)] = {'sha256': sha256(output), 'linkCommandSha256': sha256(link)}
        for token in shlex.split(link.read_text()):
            if token.endswith('.a') and not token.startswith('-'):
                library = pathlib.Path(token)
                library = library if library.is_absolute() else build / library
                if library.parent == build and library.name.startswith('lib'):
                    inspect(library.name[3:-2], library)
                    if output.stat().st_mtime_ns < library.stat().st_mtime_ns:
                        raise ValueError('Stale linked output: ' + str(output))
            if not token.endswith('.o'):
                continue
            obj = pathlib.Path(token)
            obj = obj if obj.is_absolute() else build / obj
            depfile = pathlib.Path(str(obj) + '.d')
            if not obj.is_file() or not depfile.is_file():
                raise ValueError('Missing object/dependency file: ' + str(obj))
            if output.stat().st_mtime_ns < obj.stat().st_mtime_ns:
                raise ValueError('Stale linked output: ' + str(output))
            dependencies = shlex.split(depfile.read_text().replace('\\\n', ' ').split(':', 1)[1])
            local = []
            for dependency in dependencies:
                dep = pathlib.Path(dependency)
                dep = dep if dep.is_absolute() else build / dep
                dep = dep.resolve()
                if not dep.is_file():
                    raise ValueError('Missing source dependency: ' + str(dep))
                if obj.stat().st_mtime_ns < dep.stat().st_mtime_ns:
                    raise ValueError('Stale object for source dependency: ' + str(dep))
                source_hashes[str(dep)] = sha256(dep)
                local.append(str(dep))
            if not local:
                raise ValueError('No local source dependencies: ' + str(obj))
            records[str(obj)] = {'sha256': sha256(obj), 'dependencies': local}
    for target in targets:
        inspect(target, build / target)
    return {'objectDependencies': records, 'sourceDependencies': source_hashes, 'linkedOutputs': outputs,
            'scope': 'All declared GCC depfile dependencies of recursively linked GNU Make targets, including bench files outside engine source and system headers'}
