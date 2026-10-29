import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthProvider } from "@/features/auth/AuthProvider"
import { DensityProvider } from "@/features/density/DensityProvider"
import { applyDensity, readDensity } from "@/features/density/density"
import { createQueryClient } from "@/lib/queryClient"
import { App } from "./App"
import "./index.css"

const queryClient = createQueryClient()

// Set before the first render so the page never paints at the wrong density.
applyDensity(readDensity())

// A data router, so forms can block navigation while they have unsaved edits
// (useBlocker). One splat route keeps the route table in App's <Routes>.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <AuthProvider>
        <TooltipProvider>
          <App />
          <Toaster richColors />
        </TooltipProvider>
      </AuthProvider>
    ),
  },
])

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <DensityProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </DensityProvider>
    </ThemeProvider>
  </StrictMode>,
)
