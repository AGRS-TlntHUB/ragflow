import subprocess
from pathlib import Path


def _run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("Docker CLI not found. Please install Docker.") from exc


def _candidate_containers() -> list[str]:
    result = _run_command(["docker", "ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}"])
    if result.returncode != 0:
        message = result.stderr.strip() or "docker ps failed"
        raise RuntimeError(f"Failed to list running containers: {message}")

    candidates: list[str] = []
    for line in result.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        container_id, name, image = parts
        name_l = name.lower()
        image_l = image.lower()
        if (
            "ragflow-server" in name_l
            or "infiniflow/ragflow" in image_l
            or ("ragflow" in name_l and "mysql" not in name_l and "redis" not in name_l and "es" not in name_l)
        ):
            candidates.append(container_id)
    return candidates


def _normalize_host(host: str) -> str:
    if host in {"0.0.0.0", "::", ""}:
        return "127.0.0.1"
    return host


def infer_ragflow_base_url() -> str:
    container_ids = _candidate_containers()
    if not container_ids:
        raise RuntimeError("No running RAGFlow container found.")

    for container_id in container_ids:
        for container_port in ("9380/tcp", "80/tcp"):
            result = _run_command(["docker", "port", container_id, container_port])
            if result.returncode != 0:
                continue
            line = next((ln.strip() for ln in result.stdout.splitlines() if ln.strip()), "")
            if not line:
                continue
            host_port = line.split("->")[-1].strip()
            if ":" not in host_port:
                continue
            host, port = host_port.rsplit(":", 1)
            return f"http://{_normalize_host(host)}:{port}"

    raise RuntimeError("Could not infer RAGFlow API URL from running container port mappings.")


def infer_ragflow_api_key() -> str:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        raise RuntimeError(f"API key file not found: {env_path}")

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].strip()

        if stripped.startswith("RAGFLOW_API_KEY="):
            value = stripped.split("=", 1)[1].strip().strip("'\"")
            if value:
                return value
            break

    raise RuntimeError(f"RAGFLOW_API_KEY is missing in {env_path}")
