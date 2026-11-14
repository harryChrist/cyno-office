#!/usr/bin/env python3
"""Lançador com cerca de arquivos do Cyno (Landlock do Linux).

Aplica ao PRÓPRIO processo uma regra de acesso a arquivos e depois troca por um comando (`exec`). A regra vale para o comando e para tudo que ele
abrir (filhos, gateways em segundo plano). Não precisa de sudo, de contêiner nem de biblioteca: só o `python3` do sistema (3.8 ou mais novo) e um kernel
com Landlock ligado (5.13 ou mais novo, com `landlock` em /sys/kernel/security/lsm).

Uso:
  landlock-fence.py --check                       diz (em JSON) se há Landlock e a versão da ABI; código 0 = há, 3 = não há
  landlock-fence.py [--ro P]... [--rw P]... [--rw-file P]... [--ro-file P]... -- comando [args...]

  --ro P        pasta (ou arquivo) só para leitura e execução
  --rw P        pasta (ou arquivo) para leitura e escrita (criar, apagar, renomear dentro dela)
  --ls P        só LISTAR a pasta (e as subpastas): os nomes aparecem, o conteúdo dos arquivos não (serve ao /proc: lista os PIDs sem abrir /proc/<pid>/environ)
  --ro-file P   igual a --ro, para um arquivo só (nome mais claro); --rw-file P: arquivo para leitura e escrita
  Caminho que não existe é ignorado (a lista é "o que pode"; o que falta simplesmente não entra).
  O PID do próprio lançador pode ser escrito num caminho com o texto `{pid}` (o PID não muda no `exec`): `--ro /proc/{pid}/status`.

Falha FECHADA: se a cerca não puder ser montada, o comando NÃO roda (código 125, mensagem em stderr). Quem decide usar ou não o lançador é o
Cyno, depois de `--check`.
"""
import ctypes
import json
import os
import struct
import sys

# Números das chamadas de sistema do Landlock: iguais em todas as arquiteturas (tabela genérica).
SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38
CREATE_VERSION = 1 << 0
RULE_PATH_BENEATH = 1

# Direitos de arquivo, por ABI (ver linux/landlock.h).
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
REMOVE_DIR, REMOVE_FILE, MAKE_CHAR, MAKE_DIR = 1 << 4, 1 << 5, 1 << 6, 1 << 7
MAKE_REG, MAKE_SOCK, MAKE_FIFO, MAKE_BLOCK, MAKE_SYM = 1 << 8, 1 << 9, 1 << 10, 1 << 11, 1 << 12
REFER, TRUNCATE, IOCTL_DEV = 1 << 13, 1 << 14, 1 << 15

BASE = EXECUTE | WRITE_FILE | READ_FILE | READ_DIR | REMOVE_DIR | REMOVE_FILE | MAKE_CHAR | MAKE_DIR | MAKE_REG | MAKE_SOCK | MAKE_FIFO | MAKE_BLOCK | MAKE_SYM
# Os que servem a um ARQUIVO (os outros só existem para pastas e dão EINVAL se vierem numa regra de arquivo).
FILE_ONLY = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64), ("scoped", ctypes.c_uint64)]


def abi_version():
    """A versão da ABI do Landlock do kernel (0 = sem Landlock)."""
    value = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(CREATE_VERSION))
    return int(value) if value > 0 else 0


def handled_for(abi):
    """Tudo que a ABI sabe controlar em arquivos."""
    mask = BASE
    if abi >= 2:
        mask |= REFER
    if abi >= 3:
        mask |= TRUNCATE
    if abi >= 5:
        mask |= IOCTL_DEV
    return mask


def check():
    abi = abi_version()
    lsm = ""
    try:
        with open("/sys/kernel/security/lsm") as handle:
            lsm = handle.read().strip()
    except OSError:
        pass
    print(json.dumps({"available": abi > 0, "abi": abi, "lsm": lsm, "python": "%d.%d.%d" % sys.version_info[:3]}))
    return 0 if abi > 0 else 3


def die(message, code=125):
    sys.stderr.write("landlock-fence: %s\n" % message)
    sys.exit(code)


def build(rules):
    abi = abi_version()
    if abi <= 0:
        die("este computador não tem Landlock (kernel antigo ou LSM desligado); a cerca não foi montada e o comando não roda")
    handled = handled_for(abi)
    attr = RulesetAttr(handled, 0, 0)
    # O tamanho da estrutura: só o campo de arquivos nas ABIs 1 a 3, mais rede (ABI 4), mais escopos (ABI 6): o kernel recusa tamanho maior que o que conhece.
    size = 8 if abi < 4 else (16 if abi < 6 else 24)
    fd = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0))
    if fd < 0:
        die("landlock_create_ruleset falhou: %s" % os.strerror(ctypes.get_errno()))
    read_only = (EXECUTE | READ_FILE | READ_DIR) & handled
    read_write = handled
    for mode, path in rules:
        path = path.replace("{pid}", str(os.getpid()))
        try:
            parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError:
            continue  # o que não existe não entra na lista
        try:
            is_dir = os.path.isdir(path)
            access = read_write if mode == "rw" else (READ_DIR & handled if mode == "ls" else read_only)
            if not is_dir:
                access &= FILE_ONLY
            # struct landlock_path_beneath_attr é PACKED (12 bytes): montada à mão, sem depender do _pack_ do ctypes.
            if not access:
                continue
            rule = ctypes.create_string_buffer(struct.pack("<Qi", access, parent), 12)
            if libc.syscall(SYS_ADD, ctypes.c_int(fd), ctypes.c_int(RULE_PATH_BENEATH), rule, ctypes.c_uint32(0)) < 0:
                die("landlock_add_rule falhou em %s: %s" % (path, os.strerror(ctypes.get_errno())))
        finally:
            os.close(parent)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        die("prctl(NO_NEW_PRIVS) falhou: %s" % os.strerror(ctypes.get_errno()))
    if libc.syscall(SYS_RESTRICT, ctypes.c_int(fd), ctypes.c_uint32(0)) != 0:
        die("landlock_restrict_self falhou: %s" % os.strerror(ctypes.get_errno()))
    os.close(fd)


def main(argv):
    if len(argv) == 1 and argv[0] == "--check":
        return check()
    rules = []
    i = 0
    flags = {"--ro": "ro", "--ro-file": "ro", "--rw": "rw", "--rw-file": "rw", "--ls": "ls"}
    while i < len(argv) and argv[i] != "--":
        if argv[i] in flags and i + 1 < len(argv):
            rules.append((flags[argv[i]], argv[i + 1]))
            i += 2
        else:
            die("argumento desconhecido: %s" % argv[i], 2)
    command = argv[i + 1:]
    if not command:
        die("falta o comando depois de --", 2)
    import shutil
    # Acha o executável ANTES da cerca (o PATH pode apontar para pastas que a regra não libera).
    found = shutil.which(command[0]) or command[0]
    build(rules)
    try:
        os.execv(found, command)
    except OSError as error:
        die("não consegui executar %s: %s" % (command[0], error.strerror), 127)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
