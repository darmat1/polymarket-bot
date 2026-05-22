import { App as AppContent } from "../App";

import { AppShell } from "./AppShell";

export function App() {
  return <AppShell>{(props) => <AppContent {...props} />}</AppShell>;
}
