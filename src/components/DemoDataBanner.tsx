import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Info } from "lucide-react";

interface DemoDataBannerProps {
  title?: string;
  description?: string;
}

/**
 * Banner di disclaimer per pagine interne che mostrano dataset dimostrativi
 * (Metodo Civiko One, territorio pilota Padova, microzone, opportunità, dossier).
 * Tutti i numeri, microzone, prezzi, probabilità e provvigioni mostrati sono
 * solo esempi di struttura: i dati reali vengono generati dalla dashboard
 * AcquisitionRadar sul workspace autenticato del cliente.
 */
export function DemoDataBanner({
  title = "Anteprima dimostrativa",
  description = "Questa è un'anteprima dimostrativa. I dati mostrati (microzone, prezzi, probabilità, provvigioni, opportunità) sono esempi di struttura, non opportunità reali. I dossier reali vengono generati dalla dashboard AcquisitionRadar con dati live del radar.",
}: DemoDataBannerProps) {
  return (
    <Alert>
      <Info className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}
