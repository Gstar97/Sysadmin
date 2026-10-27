import { useMemo, useState, type ReactNode } from 'react'
import { questionBankSchema } from '@/content/schemas'
import { QuizReview, QuizRunner, type QuizResult } from '@/interactive/quiz/QuizRunner'
import { percent } from '@/lib/cn'
import { Button, Callout, Card, PageHeader } from '@/ui'
import {
  Advertencia,
  Consejo,
  DiagramaInteractivo,
  Distro,
  Distros,
  EditorConfig,
  Emparejar,
  ErrorComun,
  ErroresComunes,
  mdxComponents,
  Nota,
  Ordenar,
  Resumen,
  SimuladorPaquetes,
  Subnetting,
  Terminal,
  Topologia,
  Troubleshooting,
} from '../../mdx/components'
import configCompose from './demos/config-compose.yaml'
import configNginx from './demos/config-nginx.yaml'
import diagrama from './demos/diagrama.yaml'
import emparejar from './demos/emparejar.yaml'
import modeloTcpIp from './demos/modelo-tcpip.svg?raw'
import ordenar from './demos/ordenar.yaml'
import paquetes from './demos/paquetes.yaml'
import preguntas from './demos/preguntas.yaml'
import terminalBash from './demos/terminal-bash.yaml'
import terminalIos from './demos/terminal-ios.yaml'
import terminalPs from './demos/terminal-ps.yaml'
import topologia from './demos/topologia.yaml'
import troubleshooting from './demos/troubleshooting.yaml'

const SECTIONS = [
  { id: 'terminal-linux', titulo: 'Terminal Linux' },
  { id: 'powershell', titulo: 'PowerShell' },
  { id: 'cisco', titulo: 'Consola Cisco' },
  { id: 'subnetting', titulo: 'Subnetting' },
  { id: 'topologia', titulo: 'Topologías' },
  { id: 'paquetes', titulo: 'Paquetes' },
  { id: 'diagrama', titulo: 'Diagrama' },
  { id: 'ordenar', titulo: 'Ordenar y emparejar' },
  { id: 'troubleshooting', titulo: 'Troubleshooting' },
  { id: 'editor', titulo: 'Editor de configuración' },
  { id: 'preguntas', titulo: 'Tipos de pregunta' },
  { id: 'bloques', titulo: 'Bloques de las lecciones' },
]

function Section({ id, titulo, children, descripcion }: { id: string; titulo: string; descripcion: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-line pt-8">
      <h2 className="text-xl font-bold">{titulo}</h2>
      <p className="mt-1 max-w-3xl text-muted">{descripcion}</p>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function QuestionsDemo() {
  const questions = useMemo(() => questionBankSchema.parse(preguntas).map((q) => ({ key: `galeria:${q.id}`, lessonId: 'galeria', question: q })), [])
  const [result, setResult] = useState<QuizResult>()
  const [run, setRun] = useState(0)
  if (result) {
    return (
      <div className="space-y-4">
        <Callout tone="info" title={`Resultado: ${percent(result.score)}`}>
          En una lección real, este resultado se guarda como intento del mini test. Abajo están todas las respuestas con sus explicaciones.
        </Callout>
        <Button
          variant="secondary"
          onClick={() => {
            setResult(undefined)
            setRun((r) => r + 1)
          }}
        >
          Volver a empezar
        </Button>
        <QuizReview answers={result.answers} />
      </div>
    )
  }
  return <QuizRunner key={run} questions={questions} mode="practica" onFinish={setResult} finishLabel="Ver resultado" />
}

export default function GalleryPage() {
  const Pre = mdxComponents.pre
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Etapa 2 · plataforma base" title="Galería de componentes interactivos">
        Todos los interactivos de la plataforma con ejercicios de ejemplo, tal como se ven dentro de una lección. Cada ejercicio de esta página se escribe en un archivo YAML: agregar uno nuevo
        no requiere tocar código.
      </PageHeader>
      <nav aria-label="Secciones de la galería" className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="rounded-full border border-line px-3 py-1 text-sm hover:border-accent hover:text-accent">
            {s.titulo}
          </a>
        ))}
      </nav>

      <Section id="terminal-linux" titulo="Terminal Linux (bash)" descripcion="Sistema de archivos con permisos reales, usuarios, sudo, servicios de systemd, paquetes y red. Cada paso se verifica solo después de cada comando. Prueba también ls, cat, grep, systemctl, ip a, nano...">
        <Terminal ejercicio={terminalBash} />
      </Section>

      <Section id="powershell" titulo="Windows PowerShell" descripcion="Pipeline de objetos (Where-Object, Select-Object, Sort-Object, Format-Table), archivos, servicios, procesos, eventos y el módulo ActiveDirectory. Los errores salen con el mismo formato que en Windows.">
        <Terminal ejercicio={terminalPs} />
      </Section>

      <Section id="cisco" titulo="Consola Cisco IOS" descripcion="Modos de usuario, privilegiado y configuración; abreviaturas (conf t, sh ip int br), ayuda con ?, autocompletado con Tab, running-config y startup-config. Está conectada al motor de red: un ping desde aquí usa las mismas VLAN y rutas que el armador de topologías.">
        <Terminal ejercicio={terminalIos} />
      </Section>

      <Section id="subnetting" titulo="Calculadora y entrenador de subnetting" descripcion="Calculadora IPv4 con vista binaria y división en subredes, calculadora IPv6 con EUI-64, y práctica con ejercicios al azar por tipo y dificultad, explicación paso a paso, estadísticas y modo contrarreloj.">
        <Subnetting />
      </Section>

      <Section id="topologia" titulo="Armador de topologías" descripcion="Arrastra equipos, conecta cables y configúralos con formularios o con la consola. El ping muestra el recorrido sobre el diagrama y, si falla, explica dónde y por qué.">
        <Topologia ejercicio={topologia} />
      </Section>

      <Section id="paquetes" titulo="Simulador de paquetes" descripcion="Anima cada tramo y muestra los encabezados de cada capa. Los campos que cambian respecto del paso anterior se resaltan.">
        <SimuladorPaquetes escenario={paquetes} />
      </Section>

      <Section id="diagrama" titulo="Diagrama interactivo" descripcion="SVG propio (se adapta al tema claro y oscuro) con zonas que se pueden tocar. También funciona con teclado y lector de pantalla.">
        <DiagramaInteractivo datos={diagrama} svg={modeloTcpIp} alt="Las cuatro capas del modelo TCP/IP" />
      </Section>

      <Section id="ordenar" titulo="Ordenar y emparejar" descripcion="Con mouse, pantalla táctil o teclado (botones subir y bajar en cada paso).">
        <Ordenar ejercicio={ordenar} />
        <Emparejar ejercicio={emparejar} />
      </Section>

      <Section id="troubleshooting" titulo="Troubleshooting: elige tu camino" descripcion="Un incidente simulado con evidencia real (salidas de comandos y logs). Suma el tiempo de cada decisión y al final lo compara con el camino más corto.">
        <Troubleshooting escenario={troubleshooting} />
      </Section>

      <Section id="editor" titulo="Editor de configuración con validación" descripcion="Resalta la sintaxis y marca los errores en la línea exacta mientras se escribe. Validadores para nginx, docker compose, Ansible, sshd_config, fstab y YAML; cada ejercicio suma sus propias reglas.">
        <EditorConfig ejercicio={configNginx} />
        <EditorConfig ejercicio={configCompose} />
      </Section>

      <Section id="preguntas" titulo="Tipos de pregunta" descripcion="Los seis tipos que usan los mini tests, exámenes y el diagnóstico. Cada opción explica por qué es correcta o incorrecta. Las preguntas de completar comando aceptan variantes válidas.">
        <Card>
          <QuestionsDemo />
        </Card>
      </Section>

      <Section id="bloques" titulo="Bloques de las lecciones" descripcion="Avisos, diferencias entre distribuciones, código con botón para copiar, errores comunes y resumen.">
        <div className="prosa max-w-none">
          <Nota>Los comandos de esta lección se probaron en Rocky Linux 10 y Ubuntu Server 24.04 LTS.</Nota>
          <Consejo>
            Antes de editar un archivo de configuración, haz una copia: <code>cp archivo archivo.bak</code>.
          </Consejo>
          <Advertencia>
            Un <code>rm -rf</code> con una ruta mal escrita no se puede deshacer. Revisa la ruta dos veces.
          </Advertencia>
          <Distros>
            <Distro nombre="Rocky / AlmaLinux 10">
              <p>Los paquetes se instalan con dnf y el firewall por defecto es firewalld:</p>
              <Pre>
                <code className="language-bash">{'sudo dnf install nginx\nsudo firewall-cmd --permanent --add-service=http\nsudo firewall-cmd --reload'}</code>
              </Pre>
            </Distro>
            <Distro nombre="Ubuntu Server 24.04 LTS">
              <p>Los paquetes se instalan con apt y el firewall habitual es ufw (viene desactivado):</p>
              <Pre>
                <code className="language-bash">{'sudo apt install nginx\nsudo ufw allow "Nginx HTTP"\nsudo ufw enable'}</code>
              </Pre>
            </Distro>
          </Distros>
          <ErroresComunes>
            <ErrorComun titulo='"Permission denied" al editar un archivo de /etc'>
              <p>
                Los archivos de configuración del sistema pertenecen a root. Ábrelo con sudo (por ejemplo, <code>sudo nano /etc/hosts</code>) y revisa con <code>ls -l</code> quién es el dueño.
              </p>
            </ErrorComun>
            <ErrorComun titulo="El servicio no arranca después de un cambio">
              <p>
                Mira el motivo con <code>systemctl status servicio</code> y <code>journalctl -u servicio -n 30</code>. Casi siempre el log dice la línea exacta del error.
              </p>
            </ErrorComun>
          </ErroresComunes>
          <Resumen>
            <ul>
              <li>Cada componente se usa dentro de una lección con una sola línea en el archivo MDX.</li>
              <li>Los datos de cada ejercicio están en YAML y se validan al compilar.</li>
            </ul>
          </Resumen>
        </div>
      </Section>
    </div>
  )
}
