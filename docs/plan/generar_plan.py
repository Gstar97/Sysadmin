#!/usr/bin/env python3
"""Valida el currículo (docs/plan/curriculo/*.yaml) y genera docs/PLAN_DE_CARRERA.txt.

Uso:
    python3 docs/plan/generar_plan.py           # valida y genera
    python3 docs/plan/generar_plan.py --check   # solo valida y muestra totales
"""

import re
import sys
import textwrap
from pathlib import Path

import yaml

BASE = Path(__file__).resolve().parent
CURRICULO = BASE / "curriculo"
ENCABEZADO = BASE / "encabezado.txt"
ANEXOS = BASE / "anexos.txt"
SALIDA = BASE.parent / "PLAN_DE_CARRERA.txt"

ANCHO = 92
HORAS_EXAMEN = 1  # cada examen de módulo se estima en 1 hora
RELLENO = [
    re.compile(r"lorem|ipsum|contenido pendiente|por completar", re.I),
    re.compile(r"\b(TODO|FIXME|TBD)\b"),  # en mayúsculas: "todo" en español es una palabra normal
]


def horas(valor):
    """1.0 -> '1', 2.5 -> '2,5'."""
    texto = f"{valor:g}"
    return texto.replace(".", ",")


def envolver(texto, sangria, primera=None):
    return textwrap.fill(
        " ".join(str(texto).split()),
        width=ANCHO,
        initial_indent=primera if primera is not None else sangria,
        subsequent_indent=sangria,
        break_long_words=False,
        break_on_hyphens=False,
    )


def cargar_niveles():
    niveles = []
    for archivo in sorted(CURRICULO.glob("nivel-*.yaml"), key=lambda p: int(p.stem.split("-")[1])):
        with archivo.open(encoding="utf-8") as f:
            nivel = yaml.safe_load(f)
        nivel["_archivo"] = archivo.name
        niveles.append(nivel)
    return niveles


def validar(niveles):
    errores = []
    ids_modulos = {}
    for nivel in niveles:
        for clave in ("id", "titulo", "descripcion", "perfil_salida", "modulos", "proyecto"):
            if clave not in nivel:
                errores.append(f"{nivel['_archivo']}: falta '{clave}'")
        for modulo in nivel.get("modulos", []):
            mid = modulo.get("id", "?")
            if not str(mid).startswith(f"{nivel['id']}."):
                errores.append(f"Módulo {mid}: el id no corresponde al nivel {nivel['id']}")
            if mid in ids_modulos:
                errores.append(f"Módulo {mid}: id repetido")
            ids_modulos[mid] = modulo.get("titulo", "")
            lecciones = modulo.get("lecciones", [])
            if len(lecciones) < 3:
                errores.append(f"Módulo {mid}: tiene menos de 3 lecciones")
            for i, leccion in enumerate(lecciones, 1):
                lid = f"{mid}.{i}"
                if not leccion.get("t"):
                    errores.append(f"Lección {lid}: sin título")
                if not isinstance(leccion.get("h"), (int, float)) or leccion["h"] <= 0:
                    errores.append(f"Lección {lid}: horas inválidas")
                if len(leccion.get("obj", [])) < 2:
                    errores.append(f"Lección {lid}: necesita al menos 2 objetivos")
                if not leccion.get("ui"):
                    errores.append(f"Lección {lid}: falta el elemento interactivo")
            for parte in ("lab", "caso"):
                if not modulo.get(parte, {}).get("t") or not modulo.get(parte, {}).get("h"):
                    errores.append(f"Módulo {mid}: falta '{parte}' con título y horas")
        proyecto = nivel.get("proyecto", {})
        if not proyecto.get("t") or not proyecto.get("h") or len(proyecto.get("entregables", [])) < 3:
            errores.append(f"Nivel {nivel.get('id')}: proyecto incompleto")

    for nivel in niveles:
        for modulo in nivel.get("modulos", []):
            for req in modulo.get("requiere", []):
                if req not in ids_modulos:
                    errores.append(f"Módulo {modulo['id']}: requiere '{req}', que no existe")
                elif req == modulo["id"]:
                    errores.append(f"Módulo {modulo['id']}: se requiere a sí mismo")
                elif int(req.split(".")[0]) > int(nivel["id"]):
                    errores.append(f"Módulo {modulo['id']}: requiere '{req}', de un nivel posterior")

    texto_total = yaml.safe_dump([{k: v for k, v in n.items() if k != "_archivo"} for n in niveles], allow_unicode=True)
    if any(patron.search(texto_total) for patron in RELLENO):
        errores.append("El currículo contiene texto de relleno o marcas de contenido pendiente")
    return errores, ids_modulos


def totales_modulo(modulo):
    lecciones = sum(l["h"] for l in modulo["lecciones"])
    return {
        "lecciones": lecciones,
        "lab": modulo["lab"]["h"],
        "examen": HORAS_EXAMEN,
        "caso": modulo["caso"]["h"],
        "total": lecciones + modulo["lab"]["h"] + HORAS_EXAMEN + modulo["caso"]["h"],
    }


def totales_nivel(nivel):
    t = {"lecciones": 0, "lab": 0, "examen": 0, "caso": 0, "modulos": 0, "cant_lecciones": 0}
    for modulo in nivel["modulos"]:
        tm = totales_modulo(modulo)
        for clave in ("lecciones", "lab", "examen", "caso"):
            t[clave] += tm[clave]
        t["modulos"] += 1
        t["cant_lecciones"] += len(modulo["lecciones"])
    t["proyecto"] = nivel["proyecto"]["h"]
    t["total"] = t["lecciones"] + t["lab"] + t["examen"] + t["caso"] + t["proyecto"]
    return t


def linea_con_horas(izquierda, derecha, relleno=" "):
    espacio = ANCHO - len(izquierda) - len(derecha)
    return izquierda + relleno * max(espacio, 1) + derecha


def tabla_resumen(niveles):
    filas = []
    filas.append(f"  {'Nivel':<44}{'Módulos':>9}{'Lecciones':>11}{'Horas':>9}")
    filas.append("  " + "-" * 73)
    sum_mod = sum_lec = sum_h = 0
    for nivel in niveles:
        t = totales_nivel(nivel)
        sum_mod += t["modulos"]
        sum_lec += t["cant_lecciones"]
        sum_h += t["total"]
        nombre = f"{nivel['id']}. {nivel['titulo']}"
        filas.append(f"  {nombre:<44}{t['modulos']:>9}{t['cant_lecciones']:>11}{horas(t['total']):>9}")
    filas.append("  " + "-" * 73)
    filas.append(f"  {'TOTAL':<44}{sum_mod:>9}{sum_lec:>11}{horas(sum_h):>9}")
    return "\n".join(filas), sum_mod, sum_lec, sum_h


def desglose_global(niveles):
    t = {"lecciones": 0, "lab": 0, "examen": 0, "caso": 0, "proyecto": 0}
    for nivel in niveles:
        tn = totales_nivel(nivel)
        for clave in t:
            t[clave] += tn[clave]
    return t


def render_nivel(nivel, ids_modulos):
    out = []
    t = totales_nivel(nivel)
    out.append("=" * ANCHO)
    out.append(linea_con_horas(f"NIVEL {nivel['id']} - {nivel['titulo'].upper()}", f"Total: {horas(t['total'])} h"))
    out.append("=" * ANCHO)
    out.append("")
    out.append(envolver(nivel["descripcion"], ""))
    out.append("")
    perfil = nivel["perfil_salida"].strip()
    out.append(envolver(perfil[0].lower() + perfil[1:], "  ", "Al terminar el nivel vas a poder: "))
    out.append("")
    out.append(
        envolver(
            f"Horas: lecciones {horas(t['lecciones'])} h, laboratorios {horas(t['lab'])} h, "
            f"exámenes {horas(t['examen'])} h, casos reales {horas(t['caso'])} h, "
            f"proyecto integrador {horas(t['proyecto'])} h. "
            f"{t['modulos']} módulos y {t['cant_lecciones']} lecciones.",
            "",
        )
    )
    out.append("")

    for modulo in nivel["modulos"]:
        tm = totales_modulo(modulo)
        out.append("-" * ANCHO)
        out.append(linea_con_horas(f"MÓDULO {modulo['id']} - {modulo['titulo']}", f"{horas(tm['total'])} h"))
        if modulo.get("requiere"):
            reqs = ", ".join(f"{r} {ids_modulos[r]}" for r in modulo["requiere"])
            out.append(envolver(f"Conviene haber visto antes: {reqs} (recomendación, no bloquea).", "  ", ""))
        else:
            out.append("Sin requisitos previos dentro de la carrera.")
        out.append("-" * ANCHO)
        out.append("")
        for i, leccion in enumerate(modulo["lecciones"], 1):
            lid = f"{modulo['id']}.{i}"
            out.append(linea_con_horas(f"  {lid:<7} {leccion['t']} ", f" {horas(leccion['h'])} h", "."))
            out.append("          Al terminar vas a poder:")
            for objetivo in leccion["obj"]:
                out.append(envolver(objetivo, "            ", "          - "))
            out.append(envolver(leccion["ui"], "                       ", "          Interactivo: "))
            out.append("")
        out.append("  CIERRE DEL MÓDULO")
        out.append(envolver(modulo["lab"]["t"], "      ", f"    Laboratorio guiado ({horas(modulo['lab']['h'])} h): "))
        out.append(
            envolver(
                f"Examen del módulo ({HORAS_EXAMEN} h): preguntas tomadas al azar del banco de las "
                f"{len(modulo['lecciones'])} lecciones; se aprueba con 70% (85% si se rinde para saltear el módulo).",
                "      ",
                "    ",
            )
        )
        out.append(envolver(modulo["caso"]["t"], "      ", f"    Caso real ({horas(modulo['caso']['h'])} h): "))
        out.append("")

    proyecto = nivel["proyecto"]
    out.append("*" * ANCHO)
    out.append(linea_con_horas(f"PROYECTO INTEGRADOR DEL NIVEL {nivel['id']}", f"{horas(proyecto['h'])} h"))
    out.append(envolver(proyecto["t"], "  "))
    out.append("*" * ANCHO)
    out.append("  Entregables:")
    for entregable in proyecto["entregables"]:
        out.append(envolver(entregable, "      ", "    - "))
    out.append(
        envolver(
            "Al aprobar todos los módulos del nivel y entregar el proyecto se obtiene la insignia "
            "y el certificado del nivel.",
            "  ",
        )
    )
    out.append("")
    out.append("")
    return "\n".join(out)


def main():
    niveles = cargar_niveles()
    errores, ids_modulos = validar(niveles)
    if errores:
        print("Errores en el currículo:")
        for e in errores:
            print(f"  - {e}")
        sys.exit(1)

    tabla, sum_mod, sum_lec, sum_h = tabla_resumen(niveles)
    desglose = desglose_global(niveles)
    print(tabla)

    if "--check" in sys.argv:
        return

    reemplazos = {
        "{{TABLA_RESUMEN}}": tabla,
        "{{TOTAL_HORAS}}": horas(sum_h),
        "{{TOTAL_MODULOS}}": str(sum_mod),
        "{{TOTAL_LECCIONES}}": str(sum_lec),
        "{{H_LECCIONES}}": horas(desglose["lecciones"]),
        "{{H_LABS}}": horas(desglose["lab"]),
        "{{H_EXAMENES}}": horas(desglose["examen"]),
        "{{H_CASOS}}": horas(desglose["caso"]),
        "{{H_PROYECTOS}}": horas(desglose["proyecto"]),
        "{{SEMANAS_10}}": str(round(sum_h / 10)),
        "{{SEMANAS_15}}": str(round(sum_h / 15)),
        "{{SEMANAS_25}}": str(round(sum_h / 25)),
        "{{MESES_10}}": str(round(sum_h / 10 / 4.33)),
        "{{MESES_15}}": str(round(sum_h / 15 / 4.33)),
        "{{MESES_25}}": str(round(sum_h / 25 / 4.33)),
    }
    encabezado = ENCABEZADO.read_text(encoding="utf-8")
    anexos = ANEXOS.read_text(encoding="utf-8")
    for marca, valor in reemplazos.items():
        encabezado = encabezado.replace(marca, valor)
        anexos = anexos.replace(marca, valor)

    cuerpo = "".join(render_nivel(n, ids_modulos) for n in niveles)
    SALIDA.write_text(encabezado.rstrip() + "\n\n\n" + cuerpo + anexos.rstrip() + "\n", encoding="utf-8")
    print(f"\nGenerado: {SALIDA.relative_to(BASE.parent.parent)}")


if __name__ == "__main__":
    main()
