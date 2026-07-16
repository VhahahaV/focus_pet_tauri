import { createContext, useContext } from "react";
import type { FocusPetAppController } from "./useFocusPetApp";

export const FocusPetAppContext = createContext<FocusPetAppController | null>(null);

export const useFocusPet = (): FocusPetAppController => {
  const context = useContext(FocusPetAppContext);
  if (!context) throw new Error("FocusPetAppContext is missing");
  return context;
};
