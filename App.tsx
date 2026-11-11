import React, { useState, useEffect, useRef } from 'react';
import { Medicine, AppView, AnalysisResult } from './types';
import Layout from './components/Layout';
import { ReminderModal } from './components/ReminderModal';
import { BasirLogo } from './components/BasirLogo';
import { speakText, stopAudio, subscribeToAudioState } from './services/audioService';
import { analyzeMedicineImage, chatWithAI } from './services/geminiService';
import { reminderService } from './services/reminderService';
import { auth, googleProvider, testConnection } from './services/firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import {
  subscribeUserMedicines,
  saveMedicineToFirestore,
  deleteMedicineFromFirestore,
} from './services/medicineStorage';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<AppView>(AppView.SCANNER);
  const [medicines, setMedicines] = useState<Medicine[]>(() => {
    const saved = localStorage.getItem('user_medicines');
    return saved ? JSON.parse(saved) : [];
  });
  const [user, setUser] = useState<User | null>(null);
  const [isIntroPlaying, setIsIntroPlaying] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >('default');
  const [activeReminderMedicine, setActiveReminderMedicine] = useState<Medicine | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isStartingRef = useRef(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'model'; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Subscribe to audio playback state to sync intro button
  useEffect(() => {
    const unsubscribe = subscribeToAudioState((playing) => {
      if (!playing) {
        setIsIntroPlaying(false);
      }
    });
    return unsubscribe;
  }, []);

  // Initialize Notification permission & Firestore connection check
  useEffect(() => {
    setNotificationPermission(reminderService.getPermission());
    testConnection();
  }, []);

  // Stop audio immediately whenever view changes to prevent sound overlap
  useEffect(() => {
    stopAudio();
    setIsIntroPlaying(false);
    if (currentView !== AppView.SCANNER) {
      stopCamera();
    }
  }, [currentView]);

  // Clean up all media and audio on unmount
  useEffect(() => {
    return () => {
      stopCamera();
      stopAudio();
    };
  }, []);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const unsubscribeFirestore = subscribeUserMedicines(currentUser.uid, (remoteMeds) => {
          if (remoteMeds && remoteMeds.length > 0) {
            setMedicines(remoteMeds);
          } else {
            // Sync any existing local medicines to Firestore if newly signed in
            const localSaved = localStorage.getItem('user_medicines');
            if (localSaved) {
              try {
                const parsed: Medicine[] = JSON.parse(localSaved);
                if (parsed.length > 0) {
                  parsed.forEach((m) => saveMedicineToFirestore(currentUser.uid, m));
                }
              } catch (e) {
                console.error('Error syncing local meds:', e);
              }
            }
          }
        });
        return () => unsubscribeFirestore();
      }
    });

    return () => unsubscribe();
  }, []);

  // Sync to localStorage as offline fallback
  useEffect(() => {
    localStorage.setItem('user_medicines', JSON.stringify(medicines));
  }, [medicines]);

  // Start daily medicine reminder checker
  useEffect(() => {
    reminderService.startChecking(
      () => medicines,
      (triggeredMed) => {
        setErrorMessage(`🔔 حان الآن موعد تناول دواء: ${triggeredMed.name}!`);
      }
    );

    return () => {
      reminderService.stopChecking();
    };
  }, [medicines]);

  // Handle attaching camera stream
  useEffect(() => {
    if (isCameraActive && cameraStream && videoRef.current) {
      videoRef.current.srcObject = cameraStream;
      videoRef.current.play().catch((err) => console.error('Video play error:', err));
    }

    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [isCameraActive, cameraStream]);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraStream(null);
    setIsCameraActive(false);
  };

  const startCamera = async () => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;

    stopAudio();
    stopCamera();
    await new Promise((resolve) => setTimeout(resolve, 600));

    try {
      const getStream = async (constraints: MediaStreamConstraints) => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          streamRef.current = stream;
          setCameraStream(stream);
          setIsCameraActive(true);
          speakText('تم تشغيل الكاميرا. وجه الكاميرا لاسم الدواء واضغط على زر التحليل.');
          return true;
        } catch (err) {
          return err;
        }
      };

      let result = await getStream({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });

      if (result !== true) {
        result = await getStream({ video: { facingMode: 'environment' }, audio: false });
      }

      if (result !== true) {
        result = await getStream({ video: true, audio: false });
      }

      if (result !== true) {
        const err = result as Error;
        console.error('Camera error:', err);
        if (err instanceof Error) {
          const errMsg = err.message || '';
          const errName = err.name || '';

          if (
            errName === 'NotReadableError' ||
            errName === 'AbortError' ||
            errMsg.includes('Device in use') ||
            errMsg.includes('Could not start video source')
          ) {
            speakText(
              'خطأ في تشغيل الكاميرا. قد تكون الكاميرا مشغولة في تطبيق آخر أو يمكنك التقاط صورة من جهازك.'
            );
          } else if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
            speakText('يرجى السماح بصلاحية الكاميرا للتمكن من فحص الدواء.');
          } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
            speakText('لم نجد كاميرا متصلة بجهازك. يمكنك اختيار صورة من جهازك بدلاً من ذلك.');
          } else {
            speakText('لم نتمكن من تشغيل الكاميرا المباشرة، يمكنك التقاط صورة من جهازك.');
          }
        } else {
          speakText('حدث خطأ غير متوقع عند تشغيل الكاميرا.');
        }
      }
    } finally {
      isStartingRef.current = false;
    }
  };

  const captureAndAnalyze = async (customBase64?: string) => {
    stopAudio();
    setIsAnalyzing(true);
    setAnalysisResult(null);
    setErrorMessage(null);
    speakText('جاري فحص صورة الدواء والتأكد من البيانات...');

    let base64 = customBase64;

    if (!base64) {
      if (!videoRef.current || !canvasRef.current) {
        setIsAnalyzing(false);
        return;
      }

      const video = videoRef.current;
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;

      const context = canvasRef.current.getContext('2d');
      if (context) {
        canvasRef.current.width = width;
        canvasRef.current.height = height;
        context.drawImage(video, 0, 0, width, height);
        base64 = canvasRef.current.toDataURL('image/jpeg', 0.85).split(',')[1];
      }
      stopCamera();
    }

    if (!base64) {
      setIsAnalyzing(false);
      const errMsg = 'تعذر التقاط الصورة. يرجى المحاولة مرة أخرى أو اختيار صورة من جهازك.';
      setErrorMessage(errMsg);
      speakText(errMsg);
      return;
    }

    try {
      const result = await analyzeMedicineImage(base64, medicines);
      setAnalysisResult(result);
      setIsAnalyzing(false);
      setErrorMessage(null);

      if (result.name === 'دواء غير واضح') {
        const guidance = `لم نتمكن من قراءة اسم الدواء بوضوح. ${result.warnings || 'يرجى وضع العلبة في مكان ذو إضاءة كافية وإعادة المحاولة.'}`;
        speakText(guidance);
      } else {
        const summary = `تم التعرف على الدواء: ${result.name}. دواعي الاستخدام: ${result.usage}. ${result.warnings}. ${result.interactions}`;
        speakText(summary);
      }
    } catch (error: any) {
      console.warn('Medicine analysis notice:', error?.message || error);
      const msg = error?.message || '';
      let errorArabic = 'عذراً، لم نتمكن من تحليل الدواء. تأكد من وضوح الصورة ثم حاول مجدداً.';
      if (msg.includes('quota') || msg.includes('429')) {
        errorArabic = 'عذراً، تم استهلاك الحصة المتاحة حالياً للذكاء الاصطناعي. يرجى المحاولة لاحقاً.';
      } else if (
        msg.includes('403') ||
        msg.includes('permission') ||
        msg.includes('PERMISSION_DENIED')
      ) {
        errorArabic = 'خطأ في صلاحيات مفتاح الذكاء الاصطناعي.';
      } else if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand')) {
        errorArabic = 'الخدمة تواجه ضغطاً مؤقتاً، يرجى المحاولة بعد قليل.';
      }
      setErrorMessage(errorArabic);
      speakText(errorArabic);
      setIsAnalyzing(false);
    }
  };

  // Optimized file reader that automatically scales down large mobile photos
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    stopAudio();
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      if (!dataUrl) return;

      const img = new Image();
      img.onload = () => {
        const maxDim = 1280;
        let width = img.width;
        let height = img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const ctx = tempCanvas.getContext('2d');

        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const compressed = tempCanvas.toDataURL('image/jpeg', 0.85).split(',')[1];
          captureAndAnalyze(compressed);
        } else {
          captureAndAnalyze(dataUrl.split(',')[1]);
        }
      };

      img.src = dataUrl;
    };

    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const addToProfile = async () => {
    stopAudio();
    if (analysisResult) {
      const newMed: Medicine = {
        id: Date.now().toString(),
        name: analysisResult.name,
        dosage: 'حسب التوجيهات',
        frequency: 'يومياً',
        purpose: analysisResult.usage,
        reminderTime: '08:00',
        reminderEnabled: true,
        createdAt: new Date().toISOString(),
      };

      const updated = [...medicines, newMed];
      setMedicines(updated);
      setAnalysisResult(null);

      if (user) {
        try {
          await saveMedicineToFirestore(user.uid, newMed);
        } catch (e) {
          console.error('Failed saving to firestore:', e);
        }
      }

      speakText(
        `تم حفظ دواء ${newMed.name} في ملفك الطبي مع تفعيل التذكير اليومي في الساعة الثامنة صباحاً.`
      );
    }
  };

  const handleUpdateMedicine = async (updatedMed: Medicine) => {
    setMedicines((prev) => prev.map((m) => (m.id === updatedMed.id ? updatedMed : m)));
    if (user) {
      await saveMedicineToFirestore(user.uid, updatedMed);
    }
  };

  const removeMedicine = async (id: string) => {
    stopAudio();
    const med = medicines.find((m) => m.id === id);
    setMedicines(medicines.filter((m) => m.id !== id));
    if (user) {
      try {
        await deleteMedicineFromFirestore(user.uid, id);
      } catch (e) {
        console.error('Failed to delete medicine:', e);
      }
    }
    speakText(`تم إزالة دواء ${med?.name || ''} من ملفك الطبي.`);
  };

  const sendMessage = async () => {
    if (!chatInput.trim()) return;
    stopAudio();
    const userMsg = chatInput;
    setChatInput('');
    setErrorMessage(null);
    setChatHistory((prev) => [...prev, { role: 'user', text: userMsg }]);

    try {
      const response = await chatWithAI(userMsg, medicines, []);
      setChatHistory((prev) => [...prev, { role: 'model', text: response }]);
      speakText(response);
    } catch (error: any) {
      console.error('Chat error:', error);
      const msg = error?.message || '';
      let errorArabic = 'حدث خطأ في الاتصال بالذكاء الاصطناعي.';
      if (msg.includes('quota') || msg.includes('429')) {
        errorArabic = 'عذراً، تم استهلاك الحصة المتاحة حالياً للذكاء الاصطناعي.';
      } else if (
        msg.includes('403') ||
        msg.includes('permission') ||
        msg.includes('PERMISSION_DENIED')
      ) {
        errorArabic = 'خطأ في صلاحيات مفتاح الذكاء الاصطناعي.';
      }
      setErrorMessage(errorArabic);
      speakText(errorArabic);
    }
  };

  const handleSignIn = async () => {
    stopAudio();
    try {
      const result = await signInWithPopup(auth, googleProvider);
      speakText(`أهلاً بك يا ${result.user.displayName || 'صديقي'}. تم ربط ملفك الطبي بالسحابة بنجاح.`);
    } catch (err) {
      console.error('Google Sign In error:', err);
      speakText('لم نتمكن من تسجيل الدخول. يمكنك متابعة الاستخدام دون تسجيل.');
    }
  };

  const handleSignOut = async () => {
    stopAudio();
    try {
      await signOut(auth);
      speakText('تم تسجيل الخروج بنجاح.');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  const handleRequestNotificationPermission = async () => {
    stopAudio();
    const granted = await reminderService.requestPermission();
    setNotificationPermission(reminderService.getPermission());
    if (granted) {
      speakText('تم تفعيل خدمة التذكير اليومي وإشعارات المتصفح بنجاح.');
    } else {
      speakText('تم رفض إذن الإشعارات من إعدادات المتصفح.');
    }
  };

  const handleToggleIntro = () => {
    if (isIntroPlaying) {
      stopAudio();
      setIsIntroPlaying(false);
      return;
    }

    stopAudio();
    setIsIntroPlaying(true);

    const speechText = `يا هلا فيك في تطبيق بصير، رفيقك الصيدلي الذكي.
تطبيق بصير يقدم لك ثلاث خدمات رئيسية:
أولاً، فحص وقراءة الدواء بالكاميرا لمعرفة الاسم والجرعة ودواعي الاستخدام والتحقق من عدم وجود تعارض دوائي.
ثانياً، سجل الأدوية والتذكير اليومي بمواعيد جرعاتك لتناول دوائك بأمان وفي وقته.
ثالثاً، الاستشارة الصيدلية للإجابة عن استفساراتك الطبية فورياً.
للبدء، وجّه الكاميرا نحو علبة الدواء أو اختر صورة من جهازك.`;

    speakText(speechText);
  };

  return (
    <Layout
      currentView={currentView}
      setView={setCurrentView}
      user={user}
      onSignIn={handleSignIn}
      onSignOut={handleSignOut}
      notificationPermission={notificationPermission}
      onRequestNotificationPermission={handleRequestNotificationPermission}
    >
      {/* Alert banner */}
      {errorMessage && (
        <div className="mb-6 bg-amber-50 border-2 border-amber-300 text-amber-900 p-4 rounded-2xl flex items-center justify-between shadow-sm animate-in fade-in">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <p className="font-semibold text-sm md:text-base text-right">{errorMessage}</p>
          </div>
          <button
            onClick={() => {
              stopAudio();
              setErrorMessage(null);
            }}
            className="p-2 hover:bg-amber-100 rounded-xl text-amber-800 text-sm font-bold shrink-0"
            aria-label="إغلاق التنبيه"
          >
            إغلاق ✕
          </button>
        </div>
      )}

      {/* SCANNER VIEW */}
      {currentView === AppView.SCANNER && (
        <div className="space-y-6">
          {/* Basir Brand Hero Card with Logo, Direct App Explanation and Warm Welcome */}
          <section
            aria-label="مقدمة وشرح تطبيق بصير"
            className="bg-gradient-to-br from-indigo-900 via-indigo-800 to-sky-900 text-white p-6 md:p-8 rounded-3xl shadow-xl border border-indigo-500/30 flex flex-col gap-6 text-right relative overflow-hidden"
          >
            {/* Ambient decorative glow */}
            <div className="absolute -top-24 -left-24 w-60 h-60 bg-sky-500/10 rounded-full blur-3xl pointer-events-none"></div>
            <div className="absolute -bottom-24 -right-24 w-60 h-60 bg-indigo-500/15 rounded-full blur-3xl pointer-events-none"></div>

            {/* Top row: Welcome badge & dialect label */}
            <div className="flex flex-wrap items-center justify-between gap-3 relative z-10">
              <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-md text-sky-200 border border-white/15 px-3.5 py-1.5 rounded-full text-xs md:text-sm font-bold shadow-xs">
                <span>👋</span>
                <span>
                  {user?.displayName
                    ? `يا هلا فيك يا ${user.displayName} في تطبيق بَصير`
                    : 'يا هلا فيك في تطبيق بَصير'}
                </span>
              </div>

              <div className="inline-flex items-center gap-1.5 bg-emerald-500/20 text-emerald-200 border border-emerald-400/30 px-3 py-1 rounded-full text-xs font-bold">
                <span>🇸🇦</span>
                <span>صوت ونبرة سعودية واقعية</span>
              </div>
            </div>

            {/* Middle row: Logo + Title + Direct Description */}
            <div className="flex flex-col md:flex-row items-center md:items-start gap-6 relative z-10">
              <div className="p-3 bg-white/10 rounded-3xl border border-white/20 shadow-inner backdrop-blur-md shrink-0">
                <BasirLogo className="w-24 h-24 md:w-28 md:h-28 rounded-2xl shadow-md" variant="icon" />
              </div>

              <div className="flex-1 space-y-3 text-center md:text-right">
                <h2 className="text-2xl md:text-3xl font-black tracking-tight text-white">
                  بَصير - رفيقك الصيدلي الذكي
                </h2>
                <p className="text-indigo-100 text-sm md:text-base leading-relaxed">
                  مساعدك الصوتي الذكي المصمم لقراءة علب الأدوية بدقة، شرح دواعي الاستخدام والجرعات، وتنبيهك بمواعيدها يومياً لمنع النسيان أو التعارض الدوائي.
                </p>

                {/* 3 Core pillars direct visual summary */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1 text-xs">
                  <div className="bg-white/10 hover:bg-white/15 transition-colors p-3 rounded-2xl border border-white/10 flex items-center gap-2.5">
                    <span className="text-xl">📸</span>
                    <div className="text-right">
                      <p className="font-bold text-white">ماسح الدواء</p>
                      <p className="text-indigo-200 text-[11px]">قراءة الاسم والجرعة بالكاميرا</p>
                    </div>
                  </div>

                  <div className="bg-white/10 hover:bg-white/15 transition-colors p-3 rounded-2xl border border-white/10 flex items-center gap-2.5">
                    <span className="text-xl">⏰</span>
                    <div className="text-right">
                      <p className="font-bold text-white">تذكير المواعيد</p>
                      <p className="text-indigo-200 text-[11px]">تنبيهات يومية في وقت الجرعة</p>
                    </div>
                  </div>

                  <div className="bg-white/10 hover:bg-white/15 transition-colors p-3 rounded-2xl border border-white/10 flex items-center gap-2.5">
                    <span className="text-xl">💬</span>
                    <div className="text-right">
                      <p className="font-bold text-white">استشارة صيدلية</p>
                      <p className="text-indigo-200 text-[11px]">إجابة فورية لأي استفسار</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom row: Interactive Audio Button (Speaks ONLY upon clicking here) */}
            <div className="pt-2 border-t border-white/10 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 relative z-10">
              <div className="text-xs text-indigo-200 flex items-center gap-2">
                <span className="text-base">💡</span>
                <span>اضغط على الزر للاستماع لشرح التطبيق وترحيب صوتي بالكامل:</span>
              </div>

              <button
                type="button"
                onClick={handleToggleIntro}
                className={`px-6 py-4 rounded-2xl font-black text-sm md:text-base shadow-xl transition-all flex items-center justify-center gap-3 shrink-0 active:scale-95 cursor-pointer ${
                  isIntroPlaying
                    ? 'bg-rose-600 hover:bg-rose-700 text-white border-2 border-rose-300 animate-pulse'
                    : 'bg-white hover:bg-sky-50 text-indigo-950 border-2 border-white'
                }`}
                title={isIntroPlaying ? 'إيقاف شرح التطبيق' : 'الاستماع لشرح التطبيق بصوت سعودي'}
                aria-label={isIntroPlaying ? 'إيقاف شرح التطبيق' : 'استمع لشرح التطبيق بصوت سعودي'}
              >
                {isIntroPlaying ? (
                  <>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2.5 h-2.5 bg-white rounded-xs"></span>
                      <span className="inline-block w-1.5 h-3 bg-white rounded-xs animate-bounce"></span>
                    </span>
                    <span>إيقاف الشرح الصوتي ⏹</span>
                  </>
                ) : (
                  <>
                    <span className="text-lg">🔊</span>
                    <span>استمع لشرح التطبيق والترحيب</span>
                  </>
                )}
              </button>
            </div>
          </section>

          {/* Scanner Box */}
          <div className="bg-white p-6 rounded-3xl shadow-xl border-2 border-indigo-100 flex flex-col items-center text-center overflow-hidden">
            <div className="flex items-center justify-center gap-3 mb-2">
              <BasirLogo className="w-10 h-10 rounded-2xl shadow-xs" variant="icon" />
              <h2 className="text-3xl font-bold text-indigo-900">ماسح الدواء الذكي</h2>
            </div>
            <p className="text-slate-500 mb-6">وجه الكاميرا نحو علبة الدواء لقراءتها صوتياً</p>

            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              capture="environment"
              onChange={handleFileUpload}
              className="hidden"
            />

            <div className="relative w-full aspect-[4/3] bg-black rounded-2xl overflow-hidden mb-6 border-4 border-indigo-200 flex items-center justify-center">
              {!isCameraActive ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-100 p-6 gap-4">
                  <button
                    onClick={startCamera}
                    className="flex flex-col items-center gap-3 text-indigo-600 hover:text-indigo-800 transition-colors focus:outline-none"
                    aria-label="بدء تشغيل الكاميرا المباشرة"
                  >
                    <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center shadow-inner">
                      <CameraIcon className="w-10 h-10" />
                    </div>
                    <span className="text-xl font-bold">فتح الكاميرا المباشرة</span>
                  </button>

                  <div className="w-full flex items-center gap-3 max-w-xs my-1">
                    <div className="flex-1 h-px bg-slate-200"></div>
                    <span className="text-xs text-slate-400 font-bold">أو</span>
                    <div className="flex-1 h-px bg-slate-200"></div>
                  </div>

                  <button
                    onClick={() => {
                      stopAudio();
                      fileInputRef.current?.click();
                    }}
                    className="w-full max-w-xs py-3 px-5 bg-white border-2 border-indigo-300 text-indigo-800 font-bold rounded-2xl flex items-center justify-center gap-2 hover:bg-indigo-50 transition-colors shadow-sm text-sm"
                  >
                    <span className="text-xl">📸</span>
                    <span>التقاط صورة بجهازك أو اختيارها</span>
                  </button>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover block"
                  style={{ transform: 'scaleX(1)' }}
                />
              )}
              {isAnalyzing && (
                <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-10 backdrop-blur-xs">
                  <div className="w-16 h-16 border-4 border-white border-t-transparent rounded-full animate-spin mb-4"></div>
                  <span className="text-white font-bold text-lg">جاري فحص وقراءة الدواء...</span>
                  <span className="text-indigo-200 text-xs mt-1">الذكاء الاصطناعي يتحقق من الجرعة والتعارضات</span>
                </div>
              )}
            </div>

            <canvas ref={canvasRef} className="hidden" />

            {isCameraActive && (
              <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
                <button
                  onClick={() => captureAndAnalyze()}
                  disabled={isAnalyzing}
                  className="flex-1 bg-indigo-600 text-white font-bold py-5 rounded-2xl text-xl shadow-lg hover:bg-indigo-700 active:scale-95 transition-all flex items-center justify-center gap-2"
                >
                  <CameraIcon className="w-8 h-8" />
                  تحليل الآن
                </button>
                <button
                  onClick={() => {
                    stopAudio();
                    fileInputRef.current?.click();
                  }}
                  className="px-5 py-5 bg-indigo-50 text-indigo-800 font-bold rounded-2xl hover:bg-indigo-100 flex items-center justify-center gap-2"
                  title="التقاط أو اختيار صورة من المعرض"
                >
                  <span>📸</span>
                  <span className="text-sm">صورة من الجهاز</span>
                </button>
                <button
                  onClick={() => {
                    stopAudio();
                    stopCamera();
                  }}
                  className="px-6 py-5 bg-slate-100 text-slate-600 font-bold rounded-2xl hover:bg-slate-200"
                >
                  إغلاق
                </button>
              </div>
            )}
          </div>

          {/* Analysis Results */}
          {analysisResult && (
            <div
              className={`p-6 rounded-3xl shadow-xl border-2 animate-in fade-in slide-in-from-bottom-4 ${
                analysisResult.isCompatible
                  ? 'bg-green-50 border-green-200'
                  : 'bg-red-50 border-red-200'
              }`}
            >
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-2xl font-extrabold text-slate-900">{analysisResult.name}</h3>
                <button
                  onClick={() => {
                    stopAudio();
                    speakText(
                      `الدواء هو ${analysisResult.name}. دواعي الاستخدام: ${analysisResult.usage}. المواد الفعالة: ${analysisResult.activeIngredients.join(
                        ' '
                      )}. التحذيرات: ${analysisResult.warnings}`
                    );
                  }}
                  className="p-3 bg-white rounded-full shadow-md hover:bg-slate-50 transition-colors"
                  aria-label="قراءة تفاصيل الدواء صوتياً"
                >
                  <SpeakerIcon />
                </button>
              </div>

              {!analysisResult.isCompatible && (
                <div className="bg-red-600 text-white p-4 rounded-2xl mb-4 flex items-center gap-3">
                  <WarningIcon className="w-8 h-8 shrink-0" />
                  <p className="font-bold leading-tight text-right">
                    تنبيه: هذا الدواء قد يتعارض مع أدويتك المسجلة! استشر الصيدلي أو الطبيب.
                  </p>
                </div>
              )}

              <div className="space-y-4">
                <InfoRow label="المواد الفعالة" value={analysisResult.activeIngredients.join('، ') || 'غير محدد'} />
                <InfoRow label="طريقة الاستخدام" value={analysisResult.usage} />
                <InfoRow label="تحذيرات" value={analysisResult.warnings} />
                <InfoRow label="التوافق مع أدويتك" value={analysisResult.interactions} />

                <button
                  onClick={addToProfile}
                  className="w-full bg-indigo-600 text-white font-bold py-4 rounded-2xl text-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 mt-4 flex items-center justify-center gap-2"
                >
                  <span>⏰</span>
                  <span>إضافة إلى أدويتي مع تفعيل التذكير اليومي</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* PROFILE VIEW */}
      {currentView === AppView.PROFILE && (
        <div className="space-y-6">
          {/* Header Card */}
          <div className="flex justify-between items-center bg-white p-6 rounded-3xl shadow-sm border border-slate-100">
            <div className="flex items-center gap-4">
              <BasirLogo className="w-14 h-14 rounded-2xl shadow-sm" variant="icon" />
              <div>
                <h2 className="text-3xl font-extrabold text-indigo-900">ملفي الطبي وتنبيهاتي</h2>
                <p className="text-slate-500 mt-1">
                  {user ? `حساب متصل سحابياً: ${user.email}` : 'وضع الحفظ المحلي (سجل الدخول للمزامنة)'}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                stopAudio();
                speakText(
                  `ملفك الطبي يحتوي على ${medicines.length} أدوية مسجلة. يمكنك ضبط وتعديل أوقات التنبيه اليومية لكل دواء.`
                );
              }}
              className="p-4 bg-indigo-50 text-indigo-600 rounded-full shadow-inner hover:bg-indigo-100 transition-colors"
              aria-label="قراءة ملخص الملف الطبي صوتياً"
            >
              <SpeakerIcon />
            </button>
          </div>

          {/* Daily Reminder Banner */}
          <div className="bg-gradient-to-r from-indigo-700 to-indigo-900 text-white p-6 rounded-3xl shadow-lg flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center text-3xl shrink-0">
                ⏰
              </div>
              <div>
                <h3 className="font-extrabold text-xl">نظام التذكير اليومي بمواعيد الدواء</h3>
                <p className="text-indigo-200 text-sm mt-0.5">
                  ينبهك تطبيق "بصير" صوتياً وبإشعار متصفح يومياً في الوقت المحدد لكل دواء لحمايتك.
                </p>
              </div>
            </div>

            {notificationPermission !== 'granted' ? (
              <button
                onClick={handleRequestNotificationPermission}
                className="w-full md:w-auto px-5 py-3 bg-amber-400 hover:bg-amber-300 text-indigo-950 font-bold rounded-2xl transition-all shadow text-sm shrink-0 flex items-center justify-center gap-2"
              >
                <span>🔔</span>
                <span>تفعيل إشعارات المتصفح</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 bg-emerald-500/20 text-emerald-200 border border-emerald-400/30 px-4 py-2.5 rounded-2xl text-xs font-bold shrink-0">
                <span>✓</span>
                <span>إشعارات المتصفح مفعلة وجاهزة</span>
              </div>
            )}
          </div>

          {/* Medicines List */}
          {medicines.length === 0 ? (
            <div className="bg-white p-12 rounded-3xl border-2 border-dashed border-slate-200 text-center">
              <span className="text-5xl block mb-3">💊</span>
              <p className="text-slate-400 text-lg">سجلك الطبي فارغ حالياً.</p>
              <button
                onClick={() => {
                  stopAudio();
                  setCurrentView(AppView.SCANNER);
                }}
                className="mt-4 inline-block bg-indigo-50 text-indigo-700 px-6 py-2.5 rounded-full font-bold hover:bg-indigo-100 transition-colors"
              >
                ابدأ بمسح علبة دواء الآن
              </button>
            </div>
          ) : (
            <div className="grid gap-4">
              {medicines.map((med) => (
                <div
                  key={med.id}
                  className="bg-white p-6 rounded-3xl shadow-md border border-slate-100 hover:border-indigo-200 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-3">
                      <h3 className="text-2xl font-bold text-slate-900">{med.name}</h3>
                      {med.reminderEnabled ? (
                        <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs px-3 py-1 rounded-full font-bold flex items-center gap-1">
                          <span>⏰</span>
                          <span>{med.reminderTime || '08:00'} يومياً</span>
                        </span>
                      ) : (
                        <span className="bg-slate-100 text-slate-500 text-xs px-3 py-1 rounded-full font-medium">
                          التذكير متوقف
                        </span>
                      )}
                    </div>

                    <p className="text-slate-600 text-sm leading-relaxed">{med.purpose}</p>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-xl text-xs font-bold">
                        الجرعة: {med.dosage || 'حسب التوجيهات'}
                      </span>
                      <span className="bg-slate-100 text-slate-700 px-3 py-1 rounded-xl text-xs font-medium">
                        التكرار: {med.frequency || 'يومياً'}
                      </span>
                    </div>
                  </div>

                  {/* Medicine Controls */}
                  <div className="flex flex-wrap items-center gap-2 border-t md:border-t-0 pt-3 md:pt-0 border-slate-100">
                    <button
                      onClick={() => {
                        stopAudio();
                        setActiveReminderMedicine(med);
                      }}
                      className="px-4 py-2.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-2xl font-bold text-sm flex items-center gap-1.5 transition-colors"
                      title="ضبط موعد التذكير اليومي"
                      aria-label={`ضبط موعد التذكير اليومي لدواء ${med.name}`}
                    >
                      <span>⏰</span>
                      <span>ضبط التذكير</span>
                    </button>

                    <button
                      onClick={() => {
                        stopAudio();
                        reminderService.triggerAlert(med, true);
                      }}
                      className="p-2.5 bg-amber-50 hover:bg-amber-100 text-amber-800 rounded-2xl transition-colors"
                      title="تجربة التنبيه فوراً"
                      aria-label={`تجربة تنبيه دواء ${med.name}`}
                    >
                      <span className="text-base">🔔</span>
                    </button>

                    <button
                      onClick={() => {
                        stopAudio();
                        speakText(
                          `دواء ${med.name}. استخدامه لـ: ${med.purpose}. الجرعة: ${
                            med.dosage || 'حسب التوجيهات'
                          }. موعد التذكير اليومي: ${
                            med.reminderEnabled
                              ? `الساعة ${med.reminderTime || '08:00'}`
                              : 'معطل حالياً'
                          }`
                        );
                      }}
                      className="p-2.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-2xl transition-colors"
                      title="قراءة التفاصيل صوتياً"
                      aria-label={`قراءة تفاصيل دواء ${med.name} صوتياً`}
                    >
                      <SpeakerIcon />
                    </button>

                    <button
                      onClick={() => removeMedicine(med.id)}
                      className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-colors"
                      title="حذف الدواء"
                      aria-label={`حذف دواء ${med.name}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CHAT VIEW */}
      {currentView === AppView.CHAT && (
        <div className="flex flex-col h-[calc(100vh-12rem)] md:h-[650px] bg-white rounded-3xl shadow-2xl overflow-hidden border border-indigo-50">
          <div className="bg-indigo-600 p-5 text-white flex items-center justify-between shadow-md">
            <div className="flex items-center gap-4">
              <BasirLogo className="w-12 h-12 rounded-2xl shadow-sm overflow-hidden bg-white p-0.5" variant="icon" />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-extrabold text-xl">استشارة "بصير" الطبية</h3>
                  <span className="text-[10px] bg-indigo-500 text-sky-200 font-bold px-2 py-0.5 rounded-full">
                    صوت سعودي
                  </span>
                </div>
                <span className="text-indigo-100 text-sm">رفيقك الصيدلي الذكي للإجابة عن أسئلتك</span>
              </div>
            </div>
            <button
              onClick={() => {
                stopAudio();
                speakText(
                  'أنت الآن في محادثة بصير الطبية. يمكنك كتابة أي استفسار حول أدويتك وجرعاتها وسأجيبك فوراً.'
                );
              }}
              className="p-2.5 bg-indigo-700/80 hover:bg-indigo-800 rounded-full text-white transition-colors"
              aria-label="قراءة إرشادات الاستشارة صوتياً"
            >
              <SpeakerIcon />
            </button>
          </div>

          <div className="flex-1 p-6 overflow-y-auto space-y-4 bg-slate-50">
            {chatHistory.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <div className="w-16 h-16 mx-auto mb-3 opacity-60">
                  <BasirLogo className="w-full h-full" variant="icon" />
                </div>
                <p className="text-lg font-semibold text-slate-600">أهلاً بك، كيف يمكنني مساعدتك اليوم؟</p>
                <p className="text-sm mt-1 text-slate-400">
                  اسألني عن جرعات أدويتك، موانع الاستعمال، أو الآثار الجانبية.
                </p>
              </div>
            )}
            {chatHistory.map((msg, index) => (
              <div
                key={index}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] p-4 rounded-3xl ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-none shadow-md'
                      : 'bg-white text-slate-800 border border-slate-100 shadow-sm rounded-bl-none'
                  }`}
                >
                  <p className="text-base leading-relaxed">{msg.text}</p>
                  {msg.role === 'model' && (
                    <button
                      onClick={() => {
                        stopAudio();
                        speakText(msg.text);
                      }}
                      className="mt-2 text-indigo-600 hover:text-indigo-800 text-xs font-bold flex items-center gap-1"
                    >
                      <span>🔊</span>
                      <span>إعادة القراءة صوتياً</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="p-4 bg-white border-t border-slate-100 flex gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  sendMessage();
                }
              }}
              placeholder="اكتب استفسارك الطبي هنا..."
              className="flex-1 p-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:border-indigo-600 text-base"
            />
            <button
              onClick={sendMessage}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 rounded-2xl shadow-md transition-colors"
              aria-label="إرسال الرسالة"
            >
              إرسال
            </button>
          </div>
        </div>
      )}

      {/* Reminder Edit Modal */}
      {activeReminderMedicine && (
        <ReminderModal
          medicine={activeReminderMedicine}
          onClose={() => {
            stopAudio();
            setActiveReminderMedicine(null);
          }}
          onSave={async (updatedMed) => {
            await handleUpdateMedicine(updatedMed);
            setActiveReminderMedicine(null);
          }}
        />
      )}
    </Layout>
  );
};

const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-white/80 p-4 rounded-2xl border border-slate-100">
    <span className="text-xs font-bold text-slate-400 block mb-1">{label}</span>
    <p className="text-slate-800 font-medium text-base leading-relaxed">{value}</p>
  </div>
);

const CameraIcon: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
    />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const SpeakerIcon = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
    />
  </svg>
);

const WarningIcon: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
    />
  </svg>
);

export default App;
