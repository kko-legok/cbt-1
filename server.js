const express = require('express');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));

// Inisialisasi Firestore menggunakan Kunci dari Environment Variable Render
let firestoreConfig = { projectId: 'cbt-sd-smp' };

if (process.env.GOOGLE_CREDENTIALS) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    firestoreConfig = {
      projectId: credentials.project_id || 'cbt-sd-smp',
      credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key
      }
    };
  } catch (e) {
    console.error('Error parsing GOOGLE_CREDENTIALS:', e);
  }
}

const db = new Firestore(firestoreConfig);

const COLLECTIONS = {
  SETTINGS: 'settings',
  SUBJECTS: 'subjects',
  EXAMS: 'exams',
  QUESTIONS: 'questions',
  STUDENTS: 'students',
  ATTEMPTS: 'attempts',
  CHEATING_LOGS: 'cheating_logs'
};

function response(res, success, message, data = {}, error = null) {
  return res.json({ success, message, data, error });
}

app.post('/api', async (req, res) => {
  const { action, payload } = req.body;

  try {
    switch (action) {
      case 'verifyAdmin': {
        const doc = await db.collection(COLLECTIONS.SETTINGS).doc('config').get();
        const settings = doc.exists ? doc.data() : {};
        const adminCode = settings.adminCode || 'adminpls3';
        if (payload.code === adminCode) {
          return response(res, true, 'Login admin berhasil', { authenticated: true });
        }
        return response(res, false, 'Kode admin salah', { authenticated: false });
      }

      case 'getSubjects': {
        const snapshot = await db.collection(COLLECTIONS.SUBJECTS).where('active', '==', true).get();
        const subjects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        return response(res, true, 'Data mata pelajaran', { subjects });
      }

      case 'getStudentByNisn': {
        const snapshot = await db.collection(COLLECTIONS.STUDENTS)
          .where('nisn', '==', String(payload.nisn).trim())
          .limit(1)
          .get();
        
        if (snapshot.empty) return response(res, false, 'NISN belum terdaftar.');
        const student = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
        return response(res, true, 'Data siswa ditemukan', { student });
      }

      case 'startExam': {
        const { examId, nisn } = payload;
        const studentSnap = await db.collection(COLLECTIONS.STUDENTS).where('nisn', '==', String(nisn)).limit(1).get();
        if (studentSnap.empty) return response(res, false, 'Siswa tidak ditemukan');
        
        const student = studentSnap.docs[0].data();
        const studentId = studentSnap.docs[0].id;

        const attemptRef = db.collection(COLLECTIONS.ATTEMPTS).doc();
        const now = new Date().toISOString();
        const attemptData = {
          examId,
          studentId,
          studentName: student.name || '',
          studentClass: student.class || '',
          studentNumber: student.nisn || '',
          startTime: now,
          lastActivity: now,
          status: 'active',
          cheatCount: 0,
          submitted: false
        };

        await attemptRef.set(attemptData);
        return response(res, true, 'Ujian dimulai', { attemptId: attemptRef.id, ...attemptData });
      }

      case 'saveAnswer': {
        const { attemptId, questionId, studentId, examId, answer } = payload;
        const answerRef = db.collection(COLLECTIONS.ATTEMPTS)
          .doc(attemptId)
          .collection('answers')
          .doc(questionId);

        const now = new Date().toISOString();
        await answerRef.set({ examId, studentId, questionId, answer, savedAt: now }, { merge: true });
        await db.collection(COLLECTIONS.ATTEMPTS).doc(attemptId).update({ lastActivity: now });
        return response(res, true, 'Jawaban tersimpan');
      }

      case 'recordViolation': {
        const { attemptId, violationType, description, deviceInfo } = payload;
        const attemptRef = db.collection(COLLECTIONS.ATTEMPTS).doc(attemptId);
        const attemptDoc = await attemptRef.get();
        if (!attemptDoc.exists) return response(res, false, 'Attempt tidak ditemukan');

        const currentCount = (attemptDoc.data().cheatCount || 0) + 1;
        const now = new Date().toISOString();
        const blocked = currentCount >= 3;

        await attemptRef.update({
          cheatCount: currentCount,
          lastViolationType: violationType,
          lastViolationAt: now,
          status: blocked ? 'blocked_cheating' : attemptDoc.data().status
        });

        await db.collection(COLLECTIONS.CHEATING_LOGS).add({
          attemptId,
          violationType,
          description: description || '',
          deviceInfo: deviceInfo || {},
          eventTime: now
        });

        return response(res, true, blocked ? 'Akses dihentikan' : 'Pelanggaran dicatat', { blocked, cheatCount: currentCount });
      }

      default:
        return response(res, false, 'Action tidak dikenal');
    }
  } catch (err) {
    return response(res, false, 'Terjadi kesalahan server', null, err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));