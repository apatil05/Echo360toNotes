/* oxlint-disable react/only-export-components -- a route table built from lazy page modules */
import { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { RedirectIfSignedIn, RequireAuth, RequireOnboarded } from './guards';
import { SignIn } from './auth/SignIn';
import { SignUp } from './auth/SignUp';
import { ForgotPassword } from './auth/ForgotPassword';
import { ResetPassword } from './auth/ResetPassword';
import { AuthCallback } from './auth/AuthCallback';

// Signed-out visitors only download the auth pages.
const Wizard = lazy(() => import('./onboarding/Wizard').then((m) => ({ default: m.Wizard })));
const AppLayout = lazy(() => import('./app/AppLayout').then((m) => ({ default: m.AppLayout })));
const Home = lazy(() => import('./app/Home').then((m) => ({ default: m.Home })));
const Lecture = lazy(() => import('./app/Lecture').then((m) => ({ default: m.Lecture })));
const Course = lazy(() => import('./app/Course').then((m) => ({ default: m.Course })));
const NotBuiltYet = lazy(() => import('./app/NotBuiltYet').then((m) => ({ default: m.NotBuiltYet })));

export const router = createBrowserRouter([
  { path: '/sign-in', element: <RedirectIfSignedIn><SignIn /></RedirectIfSignedIn> },
  { path: '/sign-up', element: <RedirectIfSignedIn><SignUp /></RedirectIfSignedIn> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/reset-password', element: <ResetPassword /> },
  { path: '/auth/callback', element: <AuthCallback /> },
  { path: '/welcome/:step?', element: <RequireAuth><Wizard /></RequireAuth> },
  {
    path: '/',
    element: <RequireAuth><RequireOnboarded><AppLayout /></RequireOnboarded></RequireAuth>,
    children: [
      { index: true, element: <Home /> },
      { path: 'new', element: <NotBuiltYet title="New lecture" detail="Uploading recordings and transcripts is the next screen in the build." /> },
      { path: 'courses/:id', element: <Course /> },
      { path: 'lectures/:id', element: <Lecture /> },
      { path: 'jobs/:id', element: <NotBuiltYet title="Job details" detail="Job details are coming next in the build." /> },
      { path: 'settings', element: <NotBuiltYet title="Settings" detail="Keys, linked browsers, destinations and appearance are coming next in the build." /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
