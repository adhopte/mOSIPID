// Mock university student registry (stand-in for the university's SIS). Override with STUDENTS_JSON.
export interface Student {
  studentId: string; givenName: string; familyName: string; dob: string;
  degree: string; field: string; graduationYear: number; cgpa: number; classOfDegree: string;
}

const SEED: Student[] = [
  { studentId: 'BIT2020CS001', givenName: 'Asha', familyName: 'Verma', dob: '2002-03-14', degree: 'B.Tech', field: 'Computer Science and Engineering', graduationYear: 2024, cgpa: 8.72, classOfDegree: 'First Class with Distinction' },
  { studentId: 'BIT2019EE042', givenName: 'Rohan', familyName: 'Iyer', dob: '2001-11-02', degree: 'B.Tech', field: 'Electrical Engineering', graduationYear: 2023, cgpa: 8.1, classOfDegree: 'First Class' },
  { studentId: 'BIT2021ME015', givenName: 'Meera', familyName: 'Nair', dob: '2003-07-21', degree: 'B.Tech', field: 'Mechanical Engineering', graduationYear: 2025, cgpa: 7.65, classOfDegree: 'First Class' },
  { studentId: 'BIT2018MB007', givenName: 'Vikram', familyName: 'Singh', dob: '1998-01-30', degree: 'MBA', field: 'Finance', graduationYear: 2022, cgpa: 7.9, classOfDegree: 'First Class' },
  { studentId: 'BIT2022DS003', givenName: 'Priya', familyName: 'Sharma', dob: '2000-12-09', degree: 'M.Sc', field: 'Data Science', graduationYear: 2024, cgpa: 9.05, classOfDegree: 'Distinction' },
];

export function registry(): Student[] {
  try { if (process.env.STUDENTS_JSON) return JSON.parse(process.env.STUDENTS_JSON); } catch (e) { console.warn('[students] invalid STUDENTS_JSON, using seed data'); }
  return SEED;
}

export function findStudent(studentId: string, dob: string): Student | undefined {
  const id = studentId.trim().toUpperCase();
  return registry().find((s) => s.studentId.toUpperCase() === id && s.dob === dob.trim());
}
export const getStudent = (studentId: string) => registry().find((s) => s.studentId === studentId);
