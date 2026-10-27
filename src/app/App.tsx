import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router'
import { content } from '@/content'
import { useProgress } from '@/progress/store'
import { Spinner } from '@/ui'
import { Layout } from './Layout'

const HomePage = lazy(() => import('./pages/HomePage'))
const MapPage = lazy(() => import('./pages/MapPage'))
const LevelPage = lazy(() => import('./pages/LevelPage'))
const ModulePage = lazy(() => import('./pages/ModulePage'))
const LessonPage = lazy(() => import('./pages/LessonPage'))
const ExamPage = lazy(() => import('./pages/ExamPage'))
const LabPage = lazy(() => import('./pages/LabPage'))
const CasePage = lazy(() => import('./pages/CasePage'))
const ProjectPage = lazy(() => import('./pages/ProjectPage'))
const DiagnosticPage = lazy(() => import('./pages/DiagnosticPage'))
const ReviewPage = lazy(() => import('./pages/ReviewPage'))
const GlossaryPage = lazy(() => import('./pages/GlossaryPage'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const NotesPage = lazy(() => import('./pages/NotesPage'))
const CertificatesPage = lazy(() => import('./pages/CertificatesPage'))
const CertificatePage = lazy(() => import('./pages/CertificatePage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const GalleryPage = lazy(() => import('./pages/gallery/GalleryPage'))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'))

function ScrollToTop() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (hash) {
      // Esperar a que la página cargue su contenido antes de buscar el ancla.
      const id = decodeURIComponent(hash.slice(1))
      let tries = 0
      const timer = window.setInterval(() => {
        const el = document.getElementById(id)
        if (el || ++tries > 40) {
          window.clearInterval(timer)
          el?.scrollIntoView({ block: 'start' })
        }
      }, 100)
      return () => window.clearInterval(timer)
    }
    window.scrollTo(0, 0)
  }, [pathname, hash])
  return null
}

function ProgressGate({ children }: { children: ReactNode }) {
  const ready = useProgress((s) => s.ready)
  useEffect(() => {
    void useProgress.getState().init(content)
  }, [])
  return ready ? children : <Spinner label="Cargando el progreso…" />
}

export function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Layout>
        <ProgressGate>
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/mapa" element={<MapPage />} />
              <Route path="/nivel/:levelId" element={<LevelPage />} />
              <Route path="/modulo/:moduleId" element={<ModulePage />} />
              <Route path="/leccion/:lessonId" element={<LessonPage />} />
              <Route path="/examen/:moduleId" element={<ExamPage />} />
              <Route path="/laboratorio/:moduleId" element={<LabPage />} />
              <Route path="/caso/:moduleId" element={<CasePage />} />
              <Route path="/proyecto/:levelId" element={<ProjectPage />} />
              <Route path="/diagnostico" element={<DiagnosticPage />} />
              <Route path="/repaso" element={<ReviewPage />} />
              <Route path="/glosario" element={<GlossaryPage />} />
              <Route path="/buscar" element={<SearchPage />} />
              <Route path="/notas" element={<NotesPage />} />
              <Route path="/certificados" element={<CertificatesPage />} />
              <Route path="/certificado/:levelId" element={<CertificatePage />} />
              <Route path="/ajustes" element={<SettingsPage />} />
              <Route path="/galeria" element={<GalleryPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </ProgressGate>
      </Layout>
    </BrowserRouter>
  )
}
