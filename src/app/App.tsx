import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { CommandCenterPage } from '../features/command/CommandCenterPage';
import { CollectionPage } from '../features/collection/CollectionPage';
import { JourneyPage } from '../features/journey/JourneyPage';
import { ReviewPage } from '../features/review/ReviewPage';
import { InsightsPage } from '../features/insights/InsightsPage';

export function App() {
  return <BrowserRouter><AppShell><Routes><Route path="/" element={<Navigate to="/command" replace />} /><Route path="/command" element={<CommandCenterPage />} /><Route path="/collection" element={<CollectionPage />} /><Route path="/journey" element={<JourneyPage />} /><Route path="/review" element={<ReviewPage />} /><Route path="/insights" element={<InsightsPage />} /><Route path="*" element={<Navigate to="/command" replace />} /></Routes></AppShell></BrowserRouter>;
}
